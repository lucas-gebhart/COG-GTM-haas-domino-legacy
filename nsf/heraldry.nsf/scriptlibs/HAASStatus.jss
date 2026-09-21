/*
 * HAASStatus.jss - server-side JavaScript library for heraldry.nsf XPages.
 * Status inquiry lookups, role helpers, and status vocabulary shared by HeraldryHome, StatusInquiry, ModifyRequest.
 * Loaded via <xp:script src="/HAASStatus.jss" clientSide="false"/> in ccLayout.
 */
var HAASStatus = {

	RELEASED_STATUSES: ["Released to Vendor", "In Production", "Shipped", "Complete", "Cancelled"],

	MSG_RELEASED_NOMODIFY: "This request has been released to the vendor and can no longer be modified or cancelled. Contact TACOM Clothing & Heraldry PSID for assistance. (Error 4091)",

	/** Abbreviated common name for the header bar, or "Anonymous". */
	displayUserName: function (user) {
		try {
			var cn = user.getCommonName();
			return (cn === null || cn === "") ? "Anonymous" : cn;
		} catch (e) {
			return "Anonymous";
		}
	},

	/** True if the effective user holds the given ACL role, e.g. "[TACOM]". */
	hasRole: function (role) {
		var roles = context.getUser().getRoles();
		for (var i = 0; i < roles.size(); i++) {
			if (roles.get(i) == role) { return true; }
		}
		return false;
	},

	/** Normalizes free-text status values (the Status field allows new keywords). */
	normalizeStatus: function (raw) {
		if (raw === null || raw === undefined) { return ""; }
		var s = raw.toString().trim().toLowerCase();
		var map = {
			"draft": "Draft", "new": "Draft",
			"submitted": "Submitted", "submited": "Submitted", "pending": "Submitted",
			"under review": "Under Review", "in review": "Under Review", "review": "Under Review",
			"approved": "Approved", "aproved": "Approved", "appr": "Approved",
			"released to vendor": "Released to Vendor", "released": "Released to Vendor",
			"release to vendor": "Released to Vendor", "rel to vendor": "Released to Vendor", "sent to vendor": "Released to Vendor",
			"in production": "In Production", "production": "In Production", "in prod": "In Production",
			"shipped": "Shipped", "shiped": "Shipped", "ship": "Shipped",
			"complete": "Complete", "completed": "Complete", "closed": "Complete",
			"cancelled": "Cancelled", "canceled": "Cancelled", "cancel": "Cancelled", "cxl": "Cancelled"
		};
		return map[s] !== undefined ? map[s] : raw.toString().trim();
	},

	isReleased: function (doc) {
		var st = this.normalizeStatus(doc.getItemValueString("Status"));
		if (this.RELEASED_STATUSES.indexOf(st) >= 0) { return true; }
		var rel = doc.getItemValue("ReleasedDate");
		return rel !== null && rel.size() > 0 && rel.get(0) !== null && rel.get(0).toString() !== "";
	},

	/**
	 * Status inquiry: look up by document number (14 chars) or SES flag number.
	 * Input is whitelisted to A-Z, 0-9 and hyphen, max 20 chars, before it touches the view.
	 */
	lookup: function (docNumber) {
		var key = (docNumber || "").toString().toUpperCase().replace(/[^A-Z0-9\-]/g, "");
		if (key.length < 8 || key.length > 20) {
			return { error: "Enter a 14-character document number (DODAAC + Julian date + serial) or an SES flag number." };
		}
		var vw = database.getView("StatusInquiry");
		var doc = vw.getDocumentByKey(key, true);
		if (doc === null) {
			return { error: "No request was found for document number " + key + ". Verify the number with your S4 and try again." };
		}
		var result = {
			documentNumber: key,
			form: doc.getItemValueString("Form"),
			status: this.normalizeStatus(doc.getItemValueString("Status")),
			rawStatus: doc.getItemValueString("Status"),
			unit: doc.getItemValueString("UnitName"),
			dodaac: doc.getItemValueString("DODAAC"),
			uic: doc.getItemValueString("UIC"),
			entered: doc.getItemValueString("EnteredDate"),
			released: doc.getItemValueString("ReleasedDate"),
			estimatedShip: doc.getItemValueString("EstimatedShipDate"),
			shipped: doc.getItemValueString("ShippedDate"),
			tracking: doc.getItemValueString("TrackingNumber"),
			vendor: doc.getItemValueString("VendorName"),
			canModify: !this.isReleased(doc),
			history: doc.getItemValue("StatusHistory"),
			unid: doc.getUniversalID()
		};
		doc.recycle();
		return result;
	},

	/** Counts per normalized status for the home page summary table. */
	statusSummary: function () {
		var vw = database.getView("RequestsByStatus");
		var nav = vw.createViewNavFromCategory ? null : null; // categorized nav not used: some Status values are blank
		var counts = {};
		var ent = vw.getAllEntries().getFirstEntry();
		while (ent !== null) {
			if (ent.isDocument()) {
				var cols = ent.getColumnValues();
				var st = this.normalizeStatus(cols.get(0));
				if (st !== "") { counts[st] = (counts[st] || 0) + 1; }
			}
			var next = vw.getAllEntries().getNextEntry(ent);
			ent.recycle();
			ent = next;
		}
		return counts;
	}
};
