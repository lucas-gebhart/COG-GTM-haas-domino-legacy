/*
 * HAASRequest.jss - server-side JavaScript for Request.xsp / ModifyRequest.xsp / SESFlag.xsp.
 * Re-implements the @Formula input validations because XPages does not run form-level @Formulas.
 * Keep in sync with formulas/validations.md and scriptlibs/HAASValidation.lss (three copies - known wart).
 */
var HAASRequest = {

	MAX_JUSTIFICATION: 2000,
	MAX_NAME: 80,
	MAX_LINE_QTY: 500,
	RPD_VALUES: ["01","02","03","04","05","06","07","08","09","10","11","12","13","14","15"],
	REQUEST_TYPES: ["Guidon", "Distinguishing Flag", "Organizational Colors", "Streamer", "Insignia", "Other Heraldic Item"],
	UNITS_OF_ISSUE: ["EA", "SE", "PR", "KT"],

	isAlnum: function (v) { return /^[A-Z0-9]+$/.test(v); },
	isValidDODAAC: function (v) { return v.length === 6 && this.isAlnum(v); },
	isValidUIC: function (v) { return /^W[A-Z0-9]{5}$/.test(v); },
	isValidRPD: function (v) { return this.RPD_VALUES.indexOf(v) >= 0; },
	isValidNSN: function (v) { return /^\d{4}-\d{2}-\d{3}-\d{4}$/.test(v); },
	isMilGovEmail: function (v) { return v.indexOf("@") > 0 && v.length <= 120 && (/\.mil$/i.test(v) || /\.gov$/i.test(v)); },

	/**
	 * Validate the DD1348-6 header. Returns an array of Domino-style error strings (empty = ok).
	 * Values are normalized (upper-cased / trimmed) in place on the supplied object.
	 */
	validateHeader: function (h) {
		var errors = [];
		h.DODAAC = (h.DODAAC || "").toString().trim().toUpperCase();
		h.UIC = (h.UIC || "").toString().trim().toUpperCase();
		h.RPD = (h.RPD || "").toString().trim();
		if (h.RPD.length === 1) { h.RPD = "0" + h.RPD; }
		h.UnitName = (h.UnitName || "").toString().trim();
		h.RequesterName = (h.RequesterName || "").toString().trim();
		h.RequesterEmail = (h.RequesterEmail || "").toString().trim().toLowerCase();
		h.Justification = (h.Justification || "").toString();

		if (h.DODAAC === "") { errors.push("DODAAC is required (block 1)."); }
		else if (h.DODAAC.length !== 6) { errors.push("DODAAC must be exactly 6 characters."); }
		else if (!this.isValidDODAAC(h.DODAAC)) { errors.push("DODAAC must be 6 alphanumeric characters (A-Z, 0-9)."); }

		if (h.UIC === "") { errors.push("UIC is required."); }
		else if (h.UIC.length !== 6) { errors.push("UIC must be exactly 6 characters."); }
		else if (h.UIC.charAt(0) !== "W") { errors.push("Army UICs begin with W."); }
		else if (!this.isValidUIC(h.UIC)) { errors.push("UIC must be W followed by 5 alphanumeric characters."); }

		if (!this.isValidRPD(h.RPD)) { errors.push("Requisition Priority Designator must be 01 through 15."); }
		if (this.REQUEST_TYPES.indexOf(h.RequestType) < 0) { errors.push("Select the type of heraldic item requested."); }
		if (h.UnitName === "") { errors.push("Unit designation is required."); }
		else if (h.UnitName.length > 120) { errors.push("Unit designation may not exceed 120 characters."); }
		if (h.RequesterName === "") { errors.push("Requester name is required."); }
		else if (h.RequesterName.length > this.MAX_NAME) { errors.push("Requester name may not exceed " + this.MAX_NAME + " characters."); }
		if (h.RequesterEmail === "") { errors.push("An e-mail address is required for status notifications."); }
		else if (!this.isMilGovEmail(h.RequesterEmail)) { errors.push("E-mail must be a .mil or .gov address."); }
		if ((h.ShipToAddress || "").toString().trim() === "") { errors.push("Ship-to address is required."); }
		if (h.Justification.length > this.MAX_JUSTIFICATION) { errors.push("Justification may not exceed " + this.MAX_JUSTIFICATION + " characters."); }
		return errors;
	},

	/** Validate one line item against the catalog item (may be null for exception-data lines). */
	validateLine: function (line, catalogItem) {
		var errors = [];
		var nsn = (line.NSN || "").toString().trim();
		var exc = (line.ExceptionData || "").toString().trim();
		var qty = line.Quantity;
		if (nsn === "" && exc === "") { errors.push("Enter either an NSN or exception data describing the non-NSN item."); }
		if (nsn !== "" && !this.isValidNSN(nsn)) { errors.push("NSN must be in the format 9999-99-999-9999."); }
		if (exc.length > 250) { errors.push("Exception data may not exceed 250 characters."); }
		if (this.UNITS_OF_ISSUE.indexOf(line.UnitOfIssue) < 0) { errors.push("Unit of issue must be EA, SE, PR or KT."); }
		if (qty === null || qty === undefined || qty === "" || isNaN(qty) || Number(qty) !== Math.floor(Number(qty))) {
			errors.push("Quantity must be a whole number.");
		} else if (Number(qty) < 1) {
			errors.push("Quantity must be at least 1.");
		} else if (catalogItem !== null && catalogItem.MaxQtyPerRequest && Number(qty) > Number(catalogItem.MaxQtyPerRequest)) {
			errors.push("Quantity exceeds the maximum per request for this item (see HeraldicItem.MaxQtyPerRequest). Submit a separate request or contact TACOM.");
		} else if (Number(qty) > this.MAX_LINE_QTY) {
			errors.push("Quantity may not exceed " + this.MAX_LINE_QTY + " on a single line.");
		}
		return errors;
	},

	/** MILSTRIP ordinal date: last digit of year + day-of-year (3 digits). */
	julian: function (d) {
		var start = new Date(d.getFullYear(), 0, 1);
		var day = Math.floor((d - start) / 86400000) + 1;
		return d.getFullYear().toString().slice(-1) + ("00" + day).slice(-3);
	},

	/** DODAAC(6) + Julian(4) + serial(4) = 14 character document number. */
	buildDocumentNumber: function (dodaac, d, serial) {
		return dodaac.toUpperCase() + this.julian(d) + ("0000" + serial).slice(-4);
	},

	/** Draw the next serial from the Profile document (not transactional - see README-design.md). */
	nextSerial: function (counterField) {
		var prof = database.getProfileDocument("Profile", "");
		var n = prof.getItemValueInteger(counterField);
		if (n < 1) { n = 1; }
		prof.replaceItemValue(counterField, n + 1);
		prof.save(true, false);
		return n;
	},

	/** Copies POC fields onto the Request (denormalized - the Requester doc is created if missing). */
	ensureRequester: function (h) {
		var vw = database.getView("Requesters");
		var key = "RQ~" + context.getUser().getDistinguishedName();
		var rq = vw.getDocumentByKey(key, true);
		if (rq === null) {
			rq = database.createDocument();
			rq.replaceItemValue("Form", "Requester");
			rq.replaceItemValue("RequesterKey", context.getUser().getDistinguishedName());
			rq.replaceItemValue("Name", h.RequesterName);
			rq.replaceItemValue("Rank", h.RequesterRank);
			rq.replaceItemValue("DODAAC", h.DODAAC);
			rq.replaceItemValue("UIC", h.UIC);
			rq.replaceItemValue("UnitName", h.UnitName);
			rq.replaceItemValue("Email", h.RequesterEmail);
			rq.replaceItemValue("Phone", h.RequesterPhone);
			rq.replaceItemValue("CreatedDate", session.createDateTime(new Date()));
			rq.save(true, false);
		}
		return rq.getUniversalID();
	},

	/** Domino-style status block after a change: writes sessionScope for ccStatusBanner. */
	flash: function (msg) { sessionScope.haasMessage = msg; },
	fail: function (msg) { sessionScope.haasError = msg; }
};
