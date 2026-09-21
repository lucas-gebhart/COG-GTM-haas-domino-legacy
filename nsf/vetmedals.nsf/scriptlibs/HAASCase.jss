/*
 * HAASCase.jss - SSJS helpers for the vetmedals.nsf XPages (CaseView, EngravingQueue, CSRLookup).
 * Loaded via <xp:script src="/HAASCase.jss" clientSide="false"/>.
 *
 * Stage order is duplicated here from HAASAwards.lss (LotusScript) - the two MUST be kept in sync
 * by hand; there is no shared source of truth (known wart #8).
 */
var HAASCase = {
	STAGES: ["Authorized", "Engraving", "Assembly/QC", "Warehouse", "Shipped", "Closed"],
	SPECIAL: ["On Hold", "Cancelled"],
	UNID_RE: /^[0-9A-F]{32}$/i,
	CASENO_RE: /^VMA-\d{4}-\d{6}$/,
	MAX_LOOKUP: 60,

	hasRole: function (role) {
		var roles = context.getUser().getRoles();
		for (var i = 0; i < roles.size(); i++) {
			if (roles.get(i) == role) { return true; }
		}
		return false;
	},

	/* Whitelist a documentId URL parameter; returns "" when it is not a UNID. */
	safeUnid: function (raw) {
		if (raw == null) { return ""; }
		var s = String(raw).trim();
		return this.UNID_RE.test(s) ? s.toUpperCase() : "";
	},

	/* CSR lookup box accepts a case number, a last name, or "last, first". Anything else is rejected. */
	sanitizeLookup: function (raw) {
		if (raw == null) { return ""; }
		var s = String(raw).trim().toUpperCase();
		if (s.length > this.MAX_LOOKUP) { s = s.substring(0, this.MAX_LOOKUP); }
		if (!/^[A-Z0-9 ,.'\-]*$/.test(s)) { return ""; }
		return s;
	},

	nextStage: function (stage, engravingRequired) {
		if (stage == "Authorized") { return engravingRequired ? "Engraving" : "Assembly/QC"; }
		var i = this.STAGES.indexOf(stage);
		if (i < 0 || i >= this.STAGES.length - 1) { return ""; }
		return this.STAGES[i + 1];
	},

	nextStageLabel: function (stage) {
		switch (stage) {
			case "Authorized": return "Start Engraving / Send to Assembly";
			case "Engraving": return "Engraving Complete";
			case "Assembly/QC": return "QC Passed - To Warehouse";
			case "Warehouse": return "Picked - Ship";
			case "Shipped": return "Close Case";
			default: return "";
		}
	},

	roleMayAdvance: function (stage) {
		if (this.hasRole("[TACOM]") || this.hasRole("[Admin]")) { return true; }
		switch (stage) {
			case "Authorized": return this.hasRole("[CSR]") || this.hasRole("[Engraver]");
			case "Engraving": return this.hasRole("[Engraver]");
			case "Assembly/QC": return this.hasRole("[Assembler]");
			case "Warehouse": return this.hasRole("[Warehouse]");
			case "Shipped": return this.hasRole("[CSR]") || this.hasRole("[Warehouse]");
		}
		return false;
	},

	agingClass: function (flag) {
		if (flag == "Red") { return "haasAgingRed"; }
		if (flag == "Amber") { return "haasAgingAmber"; }
		return "";
	},

	/* Days between a NotesDateTime/Date and today; -1 when missing or unparseable (pre-2009 text dates). */
	daysSince: function (value) {
		if (value == null) { return -1; }
		var d = null;
		if (value instanceof java.util.Date) {
			d = value;
		} else if (typeof value.toJavaDate == "function") {
			d = value.toJavaDate();
		} else {
			var s = String(value).trim();
			var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
			if (m) { d = new java.util.Date(parseInt(m[3].length == 2 ? "20" + m[3] : m[3], 10) - 1900, parseInt(m[1], 10) - 1, parseInt(m[2], 10)); }
			m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
			if (m) { d = new java.util.Date(parseInt(m[1], 10) - 1900, parseInt(m[2], 10) - 1, parseInt(m[3], 10)); }
		}
		if (d == null) { return -1; }
		return Math.floor((new java.util.Date().getTime() - d.getTime()) / 86400000);
	},

	/* Advance a case one stage by invoking the hidden (AdvanceStage) agent on the document. */
	advance: function (unid) {
		var db = database;
		var doc = db.getDocumentByUNID(unid);
		if (doc == null) { return "Case not found."; }
		var stage = doc.getItemValueString("Stage");
		if (!this.roleMayAdvance(stage)) { return "Your role cannot advance a case from '" + stage + "'."; }
		var agent = db.getAgent("(AdvanceStage)");
		if (agent == null) { return "Agent (AdvanceStage) is not available."; }
		agent.runWithDocumentContext(doc);
		return "";
	},

	/* Hold / release-hold from CaseView. */
	hold: function (unid, reason) {
		var doc = database.getDocumentByUNID(unid);
		if (doc == null) { return "Case not found."; }
		var stage = doc.getItemValueString("Stage");
		if (stage == "Shipped" || stage == "Closed" || stage == "Cancelled") { return "Cannot place a " + stage + " case on hold."; }
		var r = String(reason == null ? "" : reason).trim();
		if (r.length == 0 || r.length > 255) { return "A hold reason (1-255 characters) is required."; }
		doc.replaceItemValue("StageBeforeHold", stage);
		doc.replaceItemValue("Stage", "On Hold");
		doc.replaceItemValue("HoldReason", r);
		doc.replaceItemValue("StageDate", session.createDateTime(new java.util.Date()));
		var hist = doc.getItemValue("StatusHistory");
		hist.add(new java.text.SimpleDateFormat("MM/dd/yyyy HH:mm").format(new java.util.Date()) + " | " + stage + " -> On Hold | " + session.getCommonUserName());
		doc.replaceItemValue("StatusHistory", hist);
		doc.save(true, false);
		return "";
	},

	/* Lookup for CSRLookup.xsp: returns [{form, unid, key, display, extra}], max 60 rows. */
	lookup: function (raw) {
		var q = this.sanitizeLookup(raw);
		var out = [];
		if (q == "") { return out; }
		var v = database.getView("CSRLookup");
		var vec = v.getAllEntriesByKey(q, false);   // partial match on the sort key
		var e = vec.getFirstEntry();
		while (e != null && out.length < this.MAX_LOOKUP) {
			var cv = e.getColumnValues();
			out.push({ form: String(cv.get(1)), unid: e.getUniversalID(), key: String(cv.get(0)), display: String(cv.get(2)), extra: String(cv.get(3)) });
			var n = vec.getNextEntry(e);
			e.recycle();
			e = n;
		}
		return out;
	}
};
