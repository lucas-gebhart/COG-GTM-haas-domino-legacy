#!/usr/bin/env python3
"""Deterministic synthetic data export for HAAS (heraldry.nsf + vetmedals.nsf).

Writes, byte-identically on every run:
  export/dxl/heraldry-documents.dxl      Domino DXL document export (one <document> per note)
  export/dxl/vetmedals-documents.dxl
  export/csv/<db>-<Form>.csv             flattened CSV per form
  export/authorization-files/*.txt|.dat  HRC / NPRC style authorization files parsed by ImportAuthorizationFile
  export/DATA-QUALITY-NOTES.md           every intentional defect, with counts derived from the generated data

Everything personal (names, addresses, service numbers) is synthetic. Unit designations, medal
names and installation names are real public information. There is no network access and no
clock: `AS_OF` is the fixed "today" the export is taken as of.

Usage: python3 tools/generate_fixtures.py [--out export]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import os
import random
import sys
from collections import Counter
from types import SimpleNamespace
from datetime import date, datetime, timedelta

SEED = 20040218
AS_OF = date(2026, 9, 1)  # the export is taken "as of" this date; agents ran the night before
AS_OF_DT = datetime(2026, 9, 1, 6, 30)
HER_REPLICA = "C1258A1F00305C22"
VET_REPLICA = "C1258A1F00305D71"
SERVER = "CN=HAAS-APP01/O=TACOM"
AGING_AMBER = 60
AGING_RED = 75
ORPHAN_AWARDLINES = 60
ORPHAN_SHIPMENTS = 8

VOLUMES = {
    "Request": 800, "RequestLine": 2000, "SESFlagRequest": 60, "Vendor": 12, "HeraldicItem": 120,
    "Requester.heraldry": 350, "Requester.vetmedals": 2500, "AwardsCase": 3000, "AwardLine": 7000,
    "EngravingJob": 400, "ShipmentRecord": 2200, "CaseNote": 900, "AuthorizationFile": 40,
}
# AuthorizationFile documents that are still ImportStatus=Received; these are the files shipped under export/authorization-files/
PENDING_AUTH_FILES = 4

# ----------------------------------------------------------------------------------------------
# Reference data (public, real) -----------------------------------------------------------------
# ----------------------------------------------------------------------------------------------

# (unit designation, installation, state) - real Army units and posts
UNITS = [
    ("1st Battalion, 75th Ranger Regiment", "Hunter Army Airfield", "GA"),
    ("2nd Battalion, 75th Ranger Regiment", "Joint Base Lewis-McChord", "WA"),
    ("3rd Battalion, 75th Ranger Regiment", "Fort Benning", "GA"),
    ("1st Brigade Combat Team, 82nd Airborne Division", "Fort Bragg", "NC"),
    ("2nd Brigade Combat Team, 82nd Airborne Division", "Fort Bragg", "NC"),
    ("3rd Brigade Combat Team, 82nd Airborne Division", "Fort Bragg", "NC"),
    ("82nd Combat Aviation Brigade", "Fort Bragg", "NC"),
    ("1st Brigade Combat Team, 101st Airborne Division (Air Assault)", "Fort Campbell", "KY"),
    ("2nd Brigade Combat Team, 101st Airborne Division (Air Assault)", "Fort Campbell", "KY"),
    ("101st Combat Aviation Brigade", "Fort Campbell", "KY"),
    ("160th Special Operations Aviation Regiment (Airborne)", "Fort Campbell", "KY"),
    ("1st Armored Brigade Combat Team, 1st Cavalry Division", "Fort Hood", "TX"),
    ("2nd Armored Brigade Combat Team, 1st Cavalry Division", "Fort Hood", "TX"),
    ("3rd Armored Brigade Combat Team, 1st Cavalry Division", "Fort Hood", "TX"),
    ("1st Air Cavalry Brigade", "Fort Hood", "TX"),
    ("3rd Cavalry Regiment", "Fort Hood", "TX"),
    ("1st Armored Brigade Combat Team, 3rd Infantry Division", "Fort Stewart", "GA"),
    ("2nd Armored Brigade Combat Team, 3rd Infantry Division", "Fort Stewart", "GA"),
    ("3rd Combat Aviation Brigade", "Hunter Army Airfield", "GA"),
    ("1st Armored Brigade Combat Team, 1st Infantry Division", "Fort Riley", "KS"),
    ("2nd Armored Brigade Combat Team, 1st Infantry Division", "Fort Riley", "KS"),
    ("1st Stryker Brigade Combat Team, 4th Infantry Division", "Fort Carson", "CO"),
    ("2nd Stryker Brigade Combat Team, 4th Infantry Division", "Fort Carson", "CO"),
    ("3rd Armored Brigade Combat Team, 4th Infantry Division", "Fort Carson", "CO"),
    ("10th Special Forces Group (Airborne)", "Fort Carson", "CO"),
    ("1st Stryker Brigade Combat Team, 1st Armored Division", "Fort Bliss", "TX"),
    ("2nd Armored Brigade Combat Team, 1st Armored Division", "Fort Bliss", "TX"),
    ("3rd Armored Brigade Combat Team, 1st Armored Division", "Fort Bliss", "TX"),
    ("11th Air Defense Artillery Brigade", "Fort Bliss", "TX"),
    ("1st Stryker Brigade Combat Team, 2nd Infantry Division", "Joint Base Lewis-McChord", "WA"),
    ("2nd Stryker Brigade Combat Team, 2nd Infantry Division", "Joint Base Lewis-McChord", "WA"),
    ("1st Special Forces Group (Airborne)", "Joint Base Lewis-McChord", "WA"),
    ("17th Field Artillery Brigade", "Joint Base Lewis-McChord", "WA"),
    ("1st Infantry Brigade Combat Team, 11th Airborne Division", "Fort Wainwright", "AK"),
    ("2nd Infantry Brigade Combat Team, 11th Airborne Division", "Joint Base Elmendorf-Richardson", "AK"),
    ("2nd Infantry Brigade Combat Team, 25th Infantry Division", "Schofield Barracks", "HI"),
    ("3rd Infantry Brigade Combat Team, 25th Infantry Division", "Schofield Barracks", "HI"),
    ("25th Combat Aviation Brigade", "Wheeler Army Airfield", "HI"),
    ("1st Infantry Brigade Combat Team, 10th Mountain Division", "Fort Drum", "NY"),
    ("2nd Infantry Brigade Combat Team, 10th Mountain Division", "Fort Drum", "NY"),
    ("10th Combat Aviation Brigade", "Fort Drum", "NY"),
    ("3rd Infantry Brigade Combat Team, 10th Mountain Division", "Fort Polk", "LA"),
    ("2nd Cavalry Regiment", "Rose Barracks, Vilseck", "DE"),
    ("173rd Airborne Brigade", "Caserma Del Din, Vicenza", "IT"),
    ("12th Combat Aviation Brigade", "Katterbach Kaserne, Ansbach", "DE"),
    ("41st Field Artillery Brigade", "Grafenwoehr", "DE"),
    ("2nd Infantry Division / ROK-U.S. Combined Division", "Camp Humphreys", "KR"),
    ("35th Air Defense Artillery Brigade", "Osan Air Base", "KR"),
    ("3rd Special Forces Group (Airborne)", "Fort Bragg", "NC"),
    ("5th Special Forces Group (Airborne)", "Fort Campbell", "KY"),
    ("7th Special Forces Group (Airborne)", "Eglin Air Force Base", "FL"),
    ("4th Psychological Operations Group (Airborne)", "Fort Bragg", "NC"),
    ("95th Civil Affairs Brigade (Airborne)", "Fort Bragg", "NC"),
    ("528th Sustainment Brigade (Special Operations) (Airborne)", "Fort Bragg", "NC"),
    ("16th Military Police Brigade (Airborne)", "Fort Bragg", "NC"),
    ("20th Engineer Brigade (Combat) (Airborne)", "Fort Bragg", "NC"),
    ("35th Signal Brigade", "Fort Gordon", "GA"),
    ("7th Signal Command (Theater)", "Fort Gordon", "GA"),
    ("1st Information Operations Command (Land)", "Fort Belvoir", "VA"),
    ("3rd U.S. Infantry Regiment (The Old Guard)", "Fort Myer", "VA"),
    ("U.S. Army Band 'Pershing's Own'", "Fort Myer", "VA"),
    ("Military District of Washington", "Fort McNair", "DC"),
    ("U.S. Army Tank-automotive and Armaments Command", "Detroit Arsenal", "MI"),
    ("TACOM ILSC Clothing and Heraldry PSID", "Philadelphia", "PA"),
    ("U.S. Army Communications-Electronics Command", "Aberdeen Proving Ground", "MD"),
    ("U.S. Army Aviation and Missile Command", "Redstone Arsenal", "AL"),
    ("U.S. Army Sustainment Command", "Rock Island Arsenal", "IL"),
    ("U.S. Army Materiel Command", "Redstone Arsenal", "AL"),
    ("U.S. Army Training and Doctrine Command", "Fort Eustis", "VA"),
    ("U.S. Army Forces Command", "Fort Bragg", "NC"),
    ("U.S. Army Special Operations Command", "Fort Bragg", "NC"),
    ("U.S. Army Cyber Command", "Fort Gordon", "GA"),
    ("U.S. Army Human Resources Command", "Fort Knox", "KY"),
    ("U.S. Army Cadet Command", "Fort Knox", "KY"),
    ("U.S. Army Recruiting Command", "Fort Knox", "KY"),
    ("Maneuver Center of Excellence", "Fort Benning", "GA"),
    ("Fires Center of Excellence", "Fort Sill", "OK"),
    ("Aviation Center of Excellence", "Fort Rucker", "AL"),
    ("Sustainment Center of Excellence", "Fort Lee", "VA"),
    ("Medical Center of Excellence", "Joint Base San Antonio-Fort Sam Houston", "TX"),
    ("Cyber Center of Excellence", "Fort Gordon", "GA"),
    ("Intelligence Center of Excellence", "Fort Huachuca", "AZ"),
    ("United States Military Academy", "West Point", "NY"),
    ("1st Armored Division Headquarters and Headquarters Battalion", "Fort Bliss", "TX"),
    ("1st Cavalry Division Sustainment Brigade", "Fort Hood", "TX"),
    ("3rd Infantry Division Sustainment Brigade", "Fort Stewart", "GA"),
    ("82nd Airborne Division Sustainment Brigade", "Fort Bragg", "NC"),
    ("101st Airborne Division Sustainment Brigade", "Fort Campbell", "KY"),
    ("4th Infantry Division Sustainment Brigade", "Fort Carson", "CO"),
    ("18th Field Artillery Brigade", "Fort Bragg", "NC"),
    ("75th Field Artillery Brigade", "Fort Sill", "OK"),
    ("32nd Army Air and Missile Defense Command", "Fort Bliss", "TX"),
    ("108th Air Defense Artillery Brigade", "Fort Bragg", "NC"),
    ("1st Theater Sustainment Command", "Fort Knox", "KY"),
    ("8th Theater Sustainment Command", "Fort Shafter", "HI"),
    ("21st Theater Sustainment Command", "Panzer Kaserne, Kaiserslautern", "DE"),
    ("593rd Expeditionary Sustainment Command", "Joint Base Lewis-McChord", "WA"),
    ("13th Armored Corps Sustainment Command", "Fort Hood", "TX"),
    ("3rd Expeditionary Sustainment Command", "Fort Bragg", "NC"),
    ("I Corps Headquarters and Headquarters Battalion", "Joint Base Lewis-McChord", "WA"),
    ("III Armored Corps Headquarters and Headquarters Battalion", "Fort Hood", "TX"),
    ("V Corps Headquarters and Headquarters Battalion", "Fort Knox", "KY"),
    ("XVIII Airborne Corps Headquarters and Headquarters Battalion", "Fort Bragg", "NC"),
    ("28th Infantry Division (Pennsylvania Army National Guard)", "Harrisburg", "PA"),
    ("29th Infantry Division (Virginia Army National Guard)", "Fort Belvoir", "VA"),
    ("34th Infantry Division (Minnesota Army National Guard)", "Rosemount", "MN"),
    ("35th Infantry Division (Kansas Army National Guard)", "Fort Leavenworth", "KS"),
    ("36th Infantry Division (Texas Army National Guard)", "Camp Mabry, Austin", "TX"),
    ("38th Infantry Division (Indiana Army National Guard)", "Indianapolis", "IN"),
    ("40th Infantry Division (California Army National Guard)", "Los Alamitos", "CA"),
    ("42nd Infantry Division (New York Army National Guard)", "Troy", "NY"),
    ("56th Stryker Brigade Combat Team (Pennsylvania Army National Guard)", "Horsham", "PA"),
    ("116th Infantry Brigade Combat Team (Virginia Army National Guard)", "Staunton", "VA"),
    ("278th Armored Cavalry Regiment (Tennessee Army National Guard)", "Knoxville", "TN"),
    ("63rd Readiness Division (Army Reserve)", "Mountain View", "CA"),
    ("81st Readiness Division (Army Reserve)", "Fort Jackson", "SC"),
    ("88th Readiness Division (Army Reserve)", "Fort McCoy", "WI"),
    ("99th Readiness Division (Army Reserve)", "Joint Base McGuire-Dix-Lakehurst", "NJ"),
    ("377th Theater Sustainment Command (Army Reserve)", "Belle Chasse", "LA"),
    ("412th Theater Engineer Command (Army Reserve)", "Vicksburg", "MS"),
    ("807th Medical Command (Deployment Support) (Army Reserve)", "Fort Douglas", "UT"),
]

# Guidon branches (real branch names, real branch colors) for the HeraldicItem catalog
GUIDON_BRANCHES = [
    ("Infantry", "light blue"), ("Armor", "yellow"), ("Field Artillery", "scarlet"),
    ("Air Defense Artillery", "scarlet"), ("Aviation", "ultramarine blue and golden orange"),
    ("Cavalry", "yellow"), ("Corps of Engineers", "scarlet and white"), ("Signal Corps", "orange and white"),
    ("Military Police Corps", "green and yellow"), ("Army Medical Department", "maroon and white"),
    ("Ordnance Corps", "crimson and yellow"), ("Quartermaster Corps", "buff"),
    ("Transportation Corps", "brick red and golden yellow"), ("Chemical Corps", "cobalt blue and golden yellow"),
    ("Military Intelligence Corps", "oriental blue and silver gray"), ("Adjutant General's Corps", "dark blue and scarlet"),
    ("Finance Corps", "silver gray and golden yellow"), ("Special Forces", "teal blue"),
    ("Civil Affairs", "purple and white"), ("Psychological Operations", "bottle green and silver gray"),
    ("Judge Advocate General's Corps", "dark blue and white"), ("Chaplain Corps", "black"),
    ("Cyber Corps", "steel gray and black"), ("Logistics Branch", "soldier red and gold"),
]
STREAMERS = [
    ("World War II", ["Normandy", "Northern France", "Rhineland", "Ardennes-Alsace", "Central Europe", "Sicily",
                      "Naples-Foggia", "Anzio", "Rome-Arno", "North Apennines", "Po Valley", "Tunisia",
                      "New Guinea", "Leyte", "Luzon", "Ryukyus", "Bismarck Archipelago"]),
    ("Korean War", ["UN Defensive", "UN Offensive", "CCF Intervention", "First UN Counteroffensive",
                    "CCF Spring Offensive", "UN Summer-Fall Offensive", "Second Korean Winter",
                    "Korea, Summer-Fall 1952", "Third Korean Winter", "Korea, Summer 1953"]),
    ("Vietnam", ["Advisory", "Defense", "Counteroffensive", "Counteroffensive, Phase II", "Counteroffensive, Phase III",
                 "Tet Counteroffensive", "Counteroffensive, Phase IV", "Counteroffensive, Phase V",
                 "Counteroffensive, Phase VI", "Tet 69/Counteroffensive", "Summer-Fall 1969", "Winter-Spring 1970",
                 "Sanctuary Counteroffensive", "Counteroffensive, Phase VII", "Consolidation I", "Consolidation II",
                 "Cease-Fire"]),
    ("Southwest Asia", ["Defense of Saudi Arabia", "Liberation and Defense of Kuwait", "Cease-Fire"]),
    ("Iraq", ["Liberation of Iraq", "Transition of Iraq", "Iraqi Governance", "National Resolution", "Iraqi Surge",
              "Iraqi Sovereignty", "New Dawn"]),
    ("Afghanistan", ["Liberation of Afghanistan", "Consolidation I", "Consolidation II", "Consolidation III",
                     "Transition I", "Transition II"]),
]
POSITIONAL_COLORS = [
    "Secretary of the Army", "Under Secretary of the Army", "Chief of Staff, Army", "Vice Chief of Staff, Army",
    "Sergeant Major of the Army", "General (4-star)", "Lieutenant General (3-star)", "Major General (2-star)",
    "Brigadier General (1-star)", "Senior Executive Service, Tier 1", "Senior Executive Service, Tier 2",
    "Senior Executive Service, Tier 3", "Assistant Secretary of the Army",
]
DISTINGUISHING_FLAGS = [
    "Army Corps Headquarters", "Division Headquarters", "Brigade Combat Team Headquarters", "Separate Brigade",
    "Battalion Headquarters (Infantry)", "Battalion Headquarters (Armor)", "Battalion Headquarters (Field Artillery)",
    "Battalion Headquarters (Aviation)", "Battalion Headquarters (Engineer)", "Battalion Headquarters (Signal)",
    "Battalion Headquarters (Sustainment)", "Battalion Headquarters (Military Police)",
    "Army Service Component Command", "Direct Reporting Unit", "Army Command Headquarters",
    "Training Center", "Army Medical Center", "Army Depot", "Arsenal", "Army Reserve Readiness Division",
    "Army National Guard Division", "Recruiting Battalion", "ROTC Brigade", "Army Field Band",
    "Theater Sustainment Command",
]
ORG_COLORS = [
    "Infantry Regiment", "Armor Regiment", "Cavalry Regiment", "Field Artillery Regiment", "Air Defense Artillery Regiment",
    "Aviation Regiment", "Engineer Battalion", "Signal Battalion", "Military Police Battalion", "Medical Battalion",
    "Ordnance Battalion", "Quartermaster Battalion", "Transportation Battalion", "Special Forces Group",
    "Ranger Regiment", "Psychological Operations Group", "Civil Affairs Brigade", "Military Intelligence Battalion",
    "Chemical Battalion", "Sustainment Brigade", "Brigade Support Battalion",
]
AUTO_FLAGS = ["General (4-star)", "Lieutenant General (3-star)", "Major General (2-star)", "Brigadier General (1-star)",
              "Secretary of the Army", "Chief of Staff, Army", "Senior Executive Service"]
INSIGNIA = ["Shoulder Sleeve Insignia, 82nd Airborne Division", "Shoulder Sleeve Insignia, 101st Airborne Division",
            "Shoulder Sleeve Insignia, 1st Cavalry Division", "Shoulder Sleeve Insignia, 3rd Infantry Division",
            "Shoulder Sleeve Insignia, 10th Mountain Division", "Shoulder Sleeve Insignia, 25th Infantry Division",
            "Shoulder Sleeve Insignia, 1st Armored Division", "Shoulder Sleeve Insignia, 4th Infantry Division",
            "Shoulder Sleeve Insignia, TACOM", "Shoulder Sleeve Insignia, Army Materiel Command",
            "Distinctive Unit Insignia, 75th Ranger Regiment", "Distinctive Unit Insignia, 3rd Infantry Regiment",
            "Distinctive Unit Insignia, 7th Cavalry Regiment", "Distinctive Unit Insignia, 504th Infantry Regiment",
            "Distinctive Unit Insignia, 187th Infantry Regiment", "Regimental Distinctive Insignia, Quartermaster Corps"]
APPURTENANCES = ["Fringe, Golden Yellow, 2-1/2 inch", "Cord and Tassel, Golden Yellow", "Staff, Flag, Oak, 9-1/2 ft, jointed",
                 "Staff Ornament, Spearhead, Nickel", "Staff Ornament, Eagle, Gilt", "Flagstaff Base, Floor, Bronze",
                 "Guidon Staff, 7 ft, with Spearhead", "Streamer Ring, Brass", "Flag Case, Carrying, Canvas"]

VENDORS = [
    # (CAGE, name, city, state, products, active, contract)
    ("1CLR7", "Liberty Colors LLC", "Allentown", "PA", ["Organizational Colors", "Distinguishing Flag", "Positional Color"], "Yes", "W56HZV-21-D-0031"),
    ("3SRF2", "Sew-Rite Flag Company", "Scranton", "PA", ["Guidon", "Distinguishing Flag", "Streamer"], "Yes", "W56HZV-22-D-0104"),
    ("5KSB9", "Keystone Banner Works", "Lancaster", "PA", ["Guidon", "Streamer"], "Yes", "W56HZV-19-D-0087"),
    ("0PLE4", "Old Line Embroidery, Inc.", "Baltimore", "MD", ["Insignia", "Organizational Colors"], "Yes", "W56HZV-20-D-0019"),
    ("7GRN1", "Great Northern Flag & Pennant", "Duluth", "MN", ["Distinguishing Flag", "Automobile Flag"], "Yes", "W56HZV-23-D-0012"),
    ("2VLY8", "Valley Forge Regalia Co.", "Phoenixville", "PA", ["Positional Color", "Automobile Flag", "Appurtenance"], "Yes", "W56HZV-21-D-0077"),
    ("4TRD6", "Tidewater Textile Products", "Norfolk", "VA", ["Guidon", "Organizational Colors"], "Yes", "W56HZV-18-D-0140"),
    ("6HRT3", "Heartland Colors Manufacturing", "Topeka", "KS", ["Distinguishing Flag", "Streamer"], "Yes", "W56HZV-22-D-0066"),
    ("8BLU5", "Blue Ridge Emblem Company", "Roanoke", "VA", ["Insignia", "Appurtenance"], "Yes", "W56HZV-20-D-0055"),
    ("9CST0", "Coastal Standard & Guidon", "Wilmington", "NC", ["Guidon", "Automobile Flag"], "Yes", "W56HZV-24-D-0008"),
    ("1PRQ2", "Prairie Quartermaster Supply", "Fargo", "ND", ["Appurtenance", "Streamer"], "No", "W56HZV-15-D-0199"),
    ("2MDW7", "Midwest Heraldic Arts", "Rockford", "IL", ["Organizational Colors", "Insignia"], "Yes", "W56HZV-23-D-0090"),
]
DELETED_VENDOR = ("1K7Q3", "Colonial Flag & Banner Works")  # deleted 2018; still referenced (wart #4)

AWARDS = [  # (name, code, category, engrave)
    ("Medal of Honor", "MOH", "Decoration", "Yes"), ("Distinguished Service Cross", "DSC", "Decoration", "Yes"),
    ("Distinguished Service Medal", "DSM", "Decoration", "Yes"), ("Silver Star", "SS", "Decoration", "Yes"),
    ("Legion of Merit", "LM", "Decoration", "Yes"), ("Distinguished Flying Cross", "DFC", "Decoration", "Yes"),
    ("Soldier's Medal", "SM", "Decoration", "Yes"), ("Bronze Star Medal", "BSM", "Decoration", "Yes"),
    ("Purple Heart", "PH", "Decoration", "Yes"), ("Meritorious Service Medal", "MSM", "Decoration", "No"),
    ("Air Medal", "AM", "Decoration", "Yes"), ("Army Commendation Medal", "ARCOM", "Decoration", "Yes"),
    ("Army Achievement Medal", "AAM", "Decoration", "No"), ("Prisoner of War Medal", "POW", "Service Medal", "No"),
    ("Good Conduct Medal", "GCM", "Service Medal", "No"), ("Army Reserve Components Achievement Medal", "ARCAM", "Service Medal", "No"),
    ("American Defense Service Medal", "ADSM", "Campaign Medal", "No"), ("American Campaign Medal", "ACM", "Campaign Medal", "No"),
    ("European-African-Middle Eastern Campaign Medal", "EAMECM", "Campaign Medal", "No"),
    ("Asiatic-Pacific Campaign Medal", "APCM", "Campaign Medal", "No"), ("World War II Victory Medal", "WWIIVM", "Campaign Medal", "No"),
    ("Army of Occupation Medal", "AOM", "Campaign Medal", "No"), ("National Defense Service Medal", "NDSM", "Service Medal", "No"),
    ("Korean Service Medal", "KSM", "Campaign Medal", "No"), ("Vietnam Service Medal", "VSM", "Campaign Medal", "No"),
    ("Southwest Asia Service Medal", "SWASM", "Campaign Medal", "No"), ("Kosovo Campaign Medal", "KCM", "Campaign Medal", "No"),
    ("Afghanistan Campaign Medal", "ACM-A", "Campaign Medal", "No"), ("Iraq Campaign Medal", "ICM", "Campaign Medal", "No"),
    ("Global War on Terrorism Expeditionary Medal", "GWOTEM", "Campaign Medal", "No"),
    ("Global War on Terrorism Service Medal", "GWOTSM", "Service Medal", "No"), ("Korea Defense Service Medal", "KDSM", "Service Medal", "No"),
    ("Armed Forces Expeditionary Medal", "AFEM", "Campaign Medal", "No"), ("Humanitarian Service Medal", "HSM", "Service Medal", "No"),
    ("Army Service Ribbon", "ASR", "Ribbon", "No"), ("Overseas Service Ribbon", "OSR", "Ribbon", "No"),
    ("Combat Infantryman Badge", "CIB", "Badge", "No"), ("Combat Medical Badge", "CMB", "Badge", "No"),
    ("Combat Action Badge", "CAB", "Badge", "No"), ("Parachutist Badge", "PB", "Badge", "No"),
    ("Expert Infantryman Badge", "EIB", "Badge", "No"), ("Presidential Unit Citation", "PUC", "Appurtenance", "No"),
    ("Meritorious Unit Commendation", "MUC", "Appurtenance", "No"),
    ("Republic of Vietnam Gallantry Cross Unit Citation", "RVNGC", "Foreign Award", "No"),
    ("United Nations Service Medal Korea", "UNSMK", "Foreign Award", "No"),
    ("Republic of Korea War Service Medal", "ROKWSM", "Foreign Award", "No"),
    ("Republic of Vietnam Campaign Medal", "RVNCM", "Foreign Award", "No"), ("Philippine Liberation Medal", "PLM", "Foreign Award", "No"),
    ("Honorable Service Lapel Button", "HSLB", "Appurtenance", "No"), ("Gold Star Lapel Button", "GSLB", "Appurtenance", "No"),
]
AWARD_BY_CODE = {a[1]: a for a in AWARDS}
# Era -> plausible award sets (codes)
ERA_AWARDS = {
    "World War II": ["BSM", "PH", "GCM", "ADSM", "ACM", "EAMECM", "APCM", "WWIIVM", "AOM", "CIB", "CMB", "PUC", "PLM", "HSLB", "SS", "AM", "DFC"],
    "Korea": ["BSM", "PH", "GCM", "NDSM", "KSM", "UNSMK", "ROKWSM", "CIB", "CMB", "AOM", "SS", "ARCOM", "POW", "HSLB"],
    "Vietnam": ["BSM", "PH", "GCM", "NDSM", "VSM", "RVNCM", "RVNGC", "ARCOM", "AM", "CIB", "CMB", "PB", "SS", "AAM", "MUC", "HSLB"],
    "Cold War": ["GCM", "NDSM", "ARCOM", "AAM", "MSM", "AFEM", "HSM", "ASR", "OSR", "PB", "EIB", "ARCAM", "AOM"],
    "Gulf War": ["BSM", "GCM", "NDSM", "SWASM", "ARCOM", "AAM", "KCM", "ASR", "OSR", "CIB", "PB", "MSM"],
    "Global War on Terrorism": ["BSM", "PH", "GCM", "NDSM", "GWOTSM", "GWOTEM", "ICM", "ACM-A", "ARCOM", "AAM", "CAB", "CIB", "CMB", "PB", "MSM", "KDSM", "ASR", "OSR"],
    "Peacetime": ["GCM", "NDSM", "ARCOM", "AAM", "ASR", "OSR", "HSM", "ARCAM", "PB", "MSM"],
}
ERA_SERVICE = {  # era -> (from-year lo, from-year hi, typical years of service lo, hi, branch options)
    "World War II": (1940, 1945, 2, 5, ["Army of the United States", "Army Air Forces", "Women's Army Corps", "Regular Army"]),
    "Korea": (1948, 1953, 2, 4, ["Regular Army", "Army of the United States", "Army National Guard"]),
    "Vietnam": (1962, 1973, 2, 6, ["Regular Army", "Army of the United States", "Army Reserve"]),
    "Cold War": (1974, 1989, 3, 8, ["Regular Army", "Army Reserve", "Army National Guard"]),
    "Gulf War": (1986, 1991, 3, 8, ["Regular Army", "Army Reserve", "Army National Guard"]),
    "Global War on Terrorism": (1998, 2016, 3, 10, ["Regular Army", "Army Reserve", "Army National Guard"]),
    "Peacetime": (1990, 2012, 3, 8, ["Regular Army", "Army Reserve", "Army National Guard"]),
}
RANKS_ENLISTED = ["PVT", "PV2", "PFC", "SPC", "CPL", "SGT", "SSG", "SFC", "MSG", "1SG", "SGM", "T/5", "T/4", "T/SGT", "S/SGT"]
RANKS_OFFICER = ["2LT", "1LT", "CPT", "MAJ", "LTC", "COL", "WO1", "CW2", "CW3", "CW4"]

# Synthetic people. Surnames are deliberately constructed so they do not point at a real person.
FIRST_NAMES = ["James", "Robert", "John", "William", "Richard", "Charles", "Thomas", "Donald", "Harold", "Walter",
               "Raymond", "Eugene", "Ralph", "Howard", "Carl", "Arthur", "Leonard", "Clarence", "Earl", "Norman",
               "Mary", "Dorothy", "Helen", "Margaret", "Ruth", "Betty", "Virginia", "Frances", "Evelyn", "Mildred",
               "Michael", "David", "Steven", "Mark", "Kevin", "Brian", "Jeffrey", "Gary", "Timothy", "Jose",
               "Patricia", "Linda", "Barbara", "Susan", "Karen", "Nancy", "Lisa", "Sandra", "Carol", "Donna",
               "Christopher", "Matthew", "Joshua", "Daniel", "Andrew", "Anthony", "Justin", "Brandon", "Ryan", "Tyler",
               "Jennifer", "Amanda", "Jessica", "Melissa", "Sarah", "Nicole", "Stephanie", "Heather", "Elizabeth", "Angela",
               "Luis", "Carlos", "Marcus", "Andre", "Darnell", "Terrence", "Jamal", "Rafael", "Ernesto", "Hector"]
SURNAMES = ["Abernook", "Bramwold", "Cartlewood", "Dunmore-Vey", "Ellsworthy", "Fennimark", "Gastrelle", "Hollinbeck",
            "Ingersby", "Jarvinen-Roe", "Kestleman", "Lindquarry", "Marrowbridge", "Nethercott", "Oakhurst-Pell",
            "Pemberley", "Quennevile", "Rathbourne", "Stanwycke", "Thornbury", "Underhill-Voss", "Vanterpool",
            "Wexcombe", "Yarrowdale", "Zellinger", "Ashcroft-Mayne", "Beddingfield", "Coldwater", "Drakeford",
            "Everleigh", "Fairweather", "Greaves-Tolan", "Hargreave", "Iverstone", "Jessup-Kane", "Kirkbride",
            "Lockridge", "Montgomerie", "Northway", "Ormsbee", "Pettiford", "Quarterman", "Redfearn", "Sallisaw",
            "Templeton-Ash", "Ullswater", "Vandermolen", "Whitlock-Bay", "Yellowley", "Zimmerly", "Ahlquist-Bane",
            "Barrowclough", "Crandall-Mott", "Dellacroix", "Ellingboe", "Fortenbury", "Galbreath", "Haverstock",
            "Isherwood", "Jankowitz", "Kellerhaus", "Lattimore", "Mackelvane", "Norquist", "Ostrowski-Lane",
            "Prendergast", "Quimbley", "Rockwell-Sayre", "Stroudmoor", "Tarquinio", "Umberlake", "Vosburgh",
            "Wickersham", "Xanthopoulos", "Yeardley", "Zabrowski", "Altamirano-Diaz", "Benavidez-Cruz", "Castellanos",
            "Delgadillo", "Escobedo-Ruiz", "Figueroa-Paz", "Guajardo", "Hinojosa-Mata", "Izquierdo", "Jaramillo",
            "Ledesma-Ortiz", "Maldonado-Vega", "Nakashima", "Okonkwo-Bell", "Palomares", "Quinonez", "Reyes-Almonte",
            "Saldivar", "Trevino-Hale", "Urquhart", "Villanueva-Cox", "Washington-Pryce", "Yamaguchi-Orr", "Zapata-Kell"]
STREET_NAMES = ["Maple", "Oak", "Elm", "Cedar", "Walnut", "Chestnut", "Hickory", "Sycamore", "Poplar", "Birch", "Willow",
                "Spruce", "Magnolia", "Dogwood", "Laurel", "Juniper", "Lincoln", "Washington", "Jefferson", "Madison",
                "Veterans Memorial", "Armory", "Pershing", "Bradley", "Eisenhower", "Patton", "Marshall", "Ridgway"]
STREET_TYPES = ["St", "Ave", "Rd", "Dr", "Ln", "Ct", "Blvd", "Way", "Pl", "Ter"]
# (city, state, zip3 prefix) - real places, synthetic street addresses
CITIES = [("Philadelphia", "PA", "191"), ("Pittsburgh", "PA", "152"), ("Harrisburg", "PA", "171"), ("Scranton", "PA", "185"),
          ("Cleveland", "OH", "441"), ("Columbus", "OH", "432"), ("Dayton", "OH", "454"), ("Toledo", "OH", "436"),
          ("Detroit", "MI", "482"), ("Grand Rapids", "MI", "495"), ("Chicago", "IL", "606"), ("Peoria", "IL", "616"),
          ("Indianapolis", "IN", "462"), ("Fort Wayne", "IN", "468"), ("Milwaukee", "WI", "532"), ("Minneapolis", "MN", "554"),
          ("St. Louis", "MO", "631"), ("Kansas City", "MO", "641"), ("Omaha", "NE", "681"), ("Des Moines", "IA", "503"),
          ("Louisville", "KY", "402"), ("Nashville", "TN", "372"), ("Knoxville", "TN", "379"), ("Memphis", "TN", "381"),
          ("Atlanta", "GA", "303"), ("Savannah", "GA", "314"), ("Columbus", "GA", "319"), ("Jacksonville", "FL", "322"),
          ("Tampa", "FL", "336"), ("Orlando", "FL", "328"), ("Pensacola", "FL", "325"), ("Birmingham", "AL", "352"),
          ("Huntsville", "AL", "358"), ("Charlotte", "NC", "282"), ("Fayetteville", "NC", "283"), ("Raleigh", "NC", "276"),
          ("Columbia", "SC", "292"), ("Richmond", "VA", "232"), ("Norfolk", "VA", "235"), ("Baltimore", "MD", "212"),
          ("Wilmington", "DE", "198"), ("Newark", "NJ", "071"), ("Trenton", "NJ", "086"), ("Buffalo", "NY", "142"),
          ("Albany", "NY", "122"), ("Syracuse", "NY", "132"), ("Boston", "MA", "021"), ("Worcester", "MA", "016"),
          ("Hartford", "CT", "061"), ("Providence", "RI", "029"), ("Manchester", "NH", "031"), ("Portland", "ME", "041"),
          ("Dallas", "TX", "752"), ("Houston", "TX", "770"), ("San Antonio", "TX", "782"), ("El Paso", "TX", "799"),
          ("Killeen", "TX", "765"), ("Oklahoma City", "OK", "731"), ("Lawton", "OK", "735"), ("Little Rock", "AR", "722"),
          ("New Orleans", "LA", "701"), ("Shreveport", "LA", "711"), ("Jackson", "MS", "392"), ("Denver", "CO", "802"),
          ("Colorado Springs", "CO", "809"), ("Albuquerque", "NM", "871"), ("Phoenix", "AZ", "850"), ("Tucson", "AZ", "857"),
          ("Salt Lake City", "UT", "841"), ("Las Vegas", "NV", "891"), ("Los Angeles", "CA", "900"), ("San Diego", "CA", "921"),
          ("Sacramento", "CA", "958"), ("Fresno", "CA", "937"), ("Portland", "OR", "972"), ("Seattle", "WA", "981"),
          ("Tacoma", "WA", "984"), ("Spokane", "WA", "992"), ("Boise", "ID", "837"), ("Anchorage", "AK", "995"),
          ("Honolulu", "HI", "968"), ("Billings", "MT", "591"), ("Sioux Falls", "SD", "571"), ("Fargo", "ND", "581"),
          ("Cheyenne", "WY", "820"), ("Charleston", "WV", "253"), ("Wheeling", "WV", "260"), ("Burlington", "VT", "054")]

CSR_USERS = ["CN=Marlene Okafor/OU=CHPSID/O=TACOM", "CN=Renata Vasquez-Holm/OU=CHPSID/O=TACOM",
             "CN=Dwayne Petrakis/OU=CHPSID/O=TACOM", "CN=Benedetta Kowalczyk/OU=CHPSID/O=TACOM",
             "CN=Ret Hamlin/OU=CHPSID/O=TACOM", "CN=Lorraine Whitcombe/OU=CHPSID/O=TACOM"]
ENGRAVERS = ["CN=Hector Amundsen/OU=CHPSID/O=TACOM", "CN=Oswaldo Ferreira-Lund/OU=CHPSID/O=TACOM"]
ASSEMBLERS = ["CN=Tamsin Greylock/OU=CHPSID/O=TACOM", "CN=Ignatius Pardo/OU=CHPSID/O=TACOM"]
WAREHOUSE = ["CN=Cletus Marchbanks/OU=CHPSID/O=TACOM", "CN=Yolanda Strickland-Oby/OU=CHPSID/O=TACOM"]
HERALDRY_STAFF = ["CN=Lorraine Whitcombe/OU=CHPSID/O=TACOM", "CN=Ret Hamlin/OU=CHPSID/O=TACOM",
                  "CN=Dwayne Petrakis/OU=CHPSID/O=TACOM", "CN=Theodore Blankenship/OU=TroopSupport/O=DLA"]
IMPORTER = "CN=HRC-Transfer/OU=Agents/O=TACOM"
ADMIN = "CN=Domino Developer/O=HAAS"

RELATIONSHIPS = [("Self", "SE", 0.55), ("Spouse", "SP", 0.12), ("Son", "SO", 0.11), ("Daughter", "DA", 0.11),
                 ("Parent", "PA", 0.02), ("Sibling", "SI", 0.03), ("Grandchild", "GC", 0.05), ("Other NOK", "OT", 0.01)]

FREE_TEXT_STATUS = {  # keyword -> variants that survive on pre-2009 documents (wart #1)
    "Released to Vendor": ["Rel to Vendor", "REL", "released", "Release to Vendor", "sent to vendor"],
    "Complete": ["completed", "closed", "COMPLETE", "Complete "],
    "Shipped": ["shiped", "SHIPPED", "ship"],
    "Cancelled": ["canceled", "CXL", "cancel"],
    "Approved": ["aproved", "APPR"],
    "Submitted": ["submited", "pending"],
}
FREE_TEXT_STAGE = {
    "Closed": ["closed", "CLOSED", "Complete", "Closed "],
    "Shipped": ["SHIPPED", "shipped", "Ship"],
    "Assembly/QC": ["Assembly", "QC", "Assembly / QC", "assembly"],
    "Engraving": ["Engrave", "ENGRAVING", "engraving"],
    "Warehouse": ["Whse", "WAREHOUSE", "Pick"],
}


# ----------------------------------------------------------------------------------------------
# Helpers ---------------------------------------------------------------------------------------
# ----------------------------------------------------------------------------------------------

def esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&apos;"))


def unid_for(db: str, form: str, n: int) -> str:
    return hashlib.sha1(f"{db}:{form}:{n}".encode()).hexdigest()[:32].upper()


def dxl_dt(d) -> str:
    if isinstance(d, datetime):
        return d.strftime("%Y%m%dT%H%M%S,00-05")
    return d.strftime("%Y%m%d")


def us_date(d) -> str:
    return f"{d.month:02d}/{d.day:02d}/{d.year}"


def julian(d: date) -> str:
    return f"{d.year % 10}{d.timetuple().tm_yday:03d}"


def pick_weighted(rng: random.Random, options):
    """options: list of (value, weight)."""
    total = sum(w for _, w in options)
    r = rng.random() * total
    acc = 0.0
    for v, w in options:
        acc += w
        if r <= acc:
            return v
    return options[-1][0]


def rand_date(rng: random.Random, lo: date, hi: date) -> date:
    return lo + timedelta(days=rng.randint(0, (hi - lo).days))


def rand_dt(rng: random.Random, d: date, h_lo=7, h_hi=17) -> datetime:
    return datetime(d.year, d.month, d.day, rng.randint(h_lo, h_hi), rng.randint(0, 59), rng.randint(0, 59))


def business_date(rng: random.Random, lo: date, hi: date) -> date:
    d = rand_date(rng, lo, hi)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return min(d, hi) if hi.weekday() < 5 else d


def legacy_text_date(rng: random.Random, d: date) -> str:
    """One of the text shapes found on pre-2009 documents (wart #3)."""
    style = rng.randint(0, 3)
    if style == 0:
        return f"{d.month}/{d.day}/{d.year}"
    if style == 1:
        return d.strftime("%Y-%m-%d")
    if style == 2:
        return d.strftime("%d %b %y").upper()
    return d.strftime("%Y%m%d")


def alnum(rng: random.Random, n: int, alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") -> str:
    return "".join(rng.choice(alphabet) for _ in range(n))


def phone(rng: random.Random) -> str:
    return f"({rng.choice(['215', '267', '484', '610', '717', '302', '856', '410', '703', '540'])}) 555-{rng.randint(100, 199):03d}{rng.randint(0, 9)}"


def address(rng: random.Random):
    city, st, z3 = rng.choice(CITIES)
    street = f"{rng.randint(10, 9899)} {rng.choice(STREET_NAMES)} {rng.choice(STREET_TYPES)}"
    if rng.random() < 0.12:
        street += f" Apt {rng.randint(1, 40)}{rng.choice('ABCD')}"
    zipc = f"{z3}{rng.randint(0, 99):02d}"
    if rng.random() < 0.25:
        zipc += f"-{rng.randint(0, 9999):04d}"
    return street, city, st, zipc


class Note:
    """One Domino note destined for the DXL export and one CSV row."""
    __slots__ = ("form", "unid", "noteid", "created", "modified", "updatedby", "revisions", "items", "parent", "files", "seq")

    def __init__(self, form, unid, noteid, created, modified, updatedby, items, parent=None, files=None, revisions=None):
        self.form = form
        self.unid = unid
        self.noteid = noteid
        self.created = created
        self.modified = modified
        self.updatedby = updatedby
        self.revisions = revisions or [created, modified]
        self.items = items
        self.parent = parent
        self.files = files or []
        self.seq = len(self.revisions)


class Db:
    def __init__(self, key: str, replica: str, path: str, title: str):
        self.key = key
        self.replica = replica
        self.path = path
        self.title = title
        self.notes: list[Note] = []
        self.counter: Counter = Counter()
        self.noteid = 0x8F6

    def new(self, form, created, modified, updatedby, items, parent=None, files=None, revisions=None, unid=None) -> Note:
        self.counter[form] += 1
        unid = unid or unid_for(self.key, form, self.counter[form])
        self.noteid += 4
        n = Note(form, unid, f"{self.noteid:X}", created, modified, updatedby, items, parent, files, revisions)
        self.notes.append(n)
        return n


def item_xml(name: str, value, meta: dict) -> str:
    attrs = f" name='{esc(name)}'"
    if meta.get("names"):
        attrs += " names='true'"
    if meta.get("readers"):
        attrs += " readers='true'"
    if meta.get("authors"):
        attrs += " authors='true'"
    if isinstance(value, bool):
        value = "Yes" if value else "No"
    if value is None or value == "":
        return f"<item{attrs}><text/></item>"
    if isinstance(value, (int, float)):
        return f"<item{attrs}><number>{value:g}</number></item>"
    if isinstance(value, (date, datetime)):
        return f"<item{attrs}><datetime>{dxl_dt(value)}</datetime></item>"
    if isinstance(value, list):
        if not value:
            return f"<item{attrs}><textlist/></item>"
        if all(isinstance(v, (date, datetime)) for v in value):
            return f"<item{attrs}><datetimelist>" + "".join(f"<datetime>{dxl_dt(v)}</datetime>" for v in value) + "</datetimelist></item>"
        if all(isinstance(v, (int, float)) for v in value):
            return f"<item{attrs}><numberlist>" + "".join(f"<number>{v:g}</number>" for v in value) + "</numberlist></item>"
        return f"<item{attrs}><textlist>" + "".join(f"<text>{esc(str(v))}</text>" for v in value) + "</textlist></item>"
    return f"<item{attrs}><text>{esc(str(value))}</text></item>"


NAME_ITEMS = {"DocReaders": {"names": True, "readers": True}, "DocAuthors": {"names": True, "authors": True},
              "EnteredBy": {"names": True}, "ReleasedBy": {"names": True}, "CancelledBy": {"names": True},
              "ReviewedBy": {"names": True}, "ApprovedBy": {"names": True}, "LastModifiedBy": {"names": True},
              "AssignedCSR": {"names": True}, "Engraver": {"names": True}, "ShippedBy": {"names": True},
              "NoteAuthor": {"names": True}, "ImportedBy": {"names": True}, "VendorUsers": {"names": True}}


def note_xml(n: Note) -> str:
    parent = f" parent='{n.parent}'" if n.parent else ""
    out = [f"<document form='{esc(n.form)}'{parent}>"]
    out.append(f"<noteinfo noteid='{n.noteid}' unid='{n.unid}' sequence='{n.seq}'>"
               f"<created><datetime>{dxl_dt(n.created)}</datetime></created>"
               f"<modified><datetime>{dxl_dt(n.modified)}</datetime></modified>"
               f"<revised><datetime>{dxl_dt(n.modified)}</datetime></revised></noteinfo>")
    out.append(item_xml("Form", n.form, {}))
    for k, v in n.items.items():
        out.append(item_xml(k, v, NAME_ITEMS.get(k, {})))
    for fname, size, created in n.files:
        out.append(f"<item name='$FILE' sign='true' seal='true'><object><file hosttype='cdstorage' compression='none' "
                   f"flags='storedindoc' encoding='none' name='{esc(fname)}' size='{size}'>"
                   f"<created><datetime>{dxl_dt(created)}</datetime></created><modified><datetime>{dxl_dt(created)}</datetime></modified>"
                   f"</file></object></item>")
    out.append(item_xml("$UpdatedBy", n.updatedby[-20:], {"names": True}))
    out.append(item_xml("$Revisions", n.revisions[-20:], {}))
    out.append("</document>")
    return "\n".join(out)


def write_dxl(db: Db, path: str):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("<?xml version='1.0' encoding='utf-8'?>\n")
        f.write("<!DOCTYPE database SYSTEM 'xmlschemas/domino_12_0.dtd'>\n")
        f.write(f"<database xmlns='http://www.lotus.com/dxl' version='12.0' maintenanceversion='2.0' replicaid='{db.replica}' "
                f"path='{esc(db.path)}' title='{esc(db.title)}' exportdate='{dxl_dt(AS_OF_DT)}' exportedby='{esc(SERVER)}'>\n")
        f.write(f"<!-- Document export of {len(db.notes)} notes. Design elements are in nsf/{db.key}.nsf/. Synthetic data. -->\n")
        for n in db.notes:
            f.write(note_xml(n))
            f.write("\n")
        f.write("</database>\n")


def csv_value(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, datetime):
        return v.strftime("%m/%d/%Y %H:%M:%S")
    if isinstance(v, date):
        return us_date(v)
    if isinstance(v, list):
        return ";".join(csv_value(x) for x in v)
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def write_csvs(db: Db, outdir: str):
    by_form: dict[str, list[Note]] = {}
    for n in db.notes:
        by_form.setdefault(n.form, []).append(n)
    for form, notes in by_form.items():
        cols: list[str] = []
        for n in notes:
            for k in n.items:
                if k not in cols:
                    cols.append(k)
        path = os.path.join(outdir, f"{db.key}-{form}.csv")
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["UNID", "NoteID", "ParentUNID", "Created", "Modified", "LastUpdatedBy", "Attachments"] + cols)
        for n in notes:
            w.writerow([n.unid, n.noteid, n.parent or "", csv_value(n.created), csv_value(n.modified), n.updatedby[-1],
                        ";".join(f[0] for f in n.files)] + [csv_value(n.items.get(c)) for c in cols])
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(buf.getvalue())


# ----------------------------------------------------------------------------------------------
# heraldry.nsf ----------------------------------------------------------------------------------
# ----------------------------------------------------------------------------------------------

def build_heraldry(rng: random.Random, dq: dict) -> Db:
    db = Db("heraldry", HER_REPLICA, "haas\\heraldry.nsf", "Heraldry Automation System")
    staff_readers = ["[TACOM]", "[Admin]", "[ReadOnlyAudit]", "LocalDomainServers"]

    # Units -> DODAAC / UIC ------------------------------------------------------------------------
    units = []
    for i, (name, post, st) in enumerate(UNITS):
        dodaac = "W" + alnum(rng, 5)
        uic = "W" + alnum(rng, 4) + rng.choice("AA0")[0]
        units.append({"name": name, "post": post, "state": st, "dodaac": dodaac, "uic": uic})

    # Vendors -----------------------------------------------------------------------------------
    vendor_docs = {}
    for cage, name, city, st, products, active, contract in VENDORS:
        created = rand_dt(rng, rand_date(rng, date(2004, 3, 1), date(2019, 6, 30)))
        modified = rand_dt(rng, rand_date(rng, created.date(), AS_OF))
        poc = f"{rng.choice(FIRST_NAMES)} {rng.choice(SURNAMES)}"
        users = [f"CN={poc}/O={name}"]
        n = db.new("Vendor", created, modified, [ADMIN, rng.choice(HERALDRY_STAFF)], {
            "VendorKey": cage, "VendorName": name, "Address": f"{rng.randint(100, 9999)} Industrial {rng.choice(['Pkwy', 'Blvd', 'Dr'])}",
            "City": city, "State": st, "ZIP": f"{rng.randint(10000, 99999)}", "POC": poc, "Phone": phone(rng),
            "Email": f"{poc.split()[0].lower()}.{poc.split()[1].lower().split('-')[0]}@{name.lower().split()[0]}.example.com",
            "Products": products, "ContractNumber": contract, "LeadTimeDays": rng.choice([30, 45, 60, 75, 90]), "Active": active,
            "VendorUsers": users, "VendorGroup": "Heraldry-Vendors", "DocReaders": staff_readers + ["[Vendor]"],
        }, revisions=[created, modified])
        vendor_docs[cage] = n
    active_vendors = [v for v in VENDORS if v[5] == "Yes"]

    # Heraldic catalog -----------------------------------------------------------------------------
    items = []
    def add_item(cat, name, fsc, uoi, price, maxq, lead, branch="Army", ref="AR 840-10"):
        niin = f"{rng.choice(['00', '01'])}-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}"
        sn = f"{fsc}-{niin}"
        vendors = [v[0] for v in VENDORS if cat in v[4]] or [rng.choice(active_vendors)[0]]
        created = rand_dt(rng, rand_date(rng, date(2004, 2, 18), date(2012, 12, 31)))
        modified = rand_dt(rng, rand_date(rng, created.date(), AS_OF))
        active = "No" if rng.random() < 0.06 else "Yes"
        n = db.new("HeraldicItem", created, modified, [ADMIN, rng.choice(HERALDRY_STAFF)], {
            "StockNumber": sn, "ItemName": name, "Category": cat,
            "Description": f"{name}; per {ref}; heraldic specification TIOH.", "Branch": branch,
            "UnitOfIssue": uoi, "UnitPrice": price, "MaxQtyPerRequest": maxq, "LeadTimeDays": lead,
            "ApprovedVendors": vendors, "Reference": ref, "Active": active, "FSC": fsc, "NIIN": niin,
        })
        items.append(n)
    for br, color in GUIDON_BRANCHES[:20]:
        add_item("Guidon", f"Guidon, {br}, 20 in x 27-3/4 in, {color}", "8345", "EA", round(rng.uniform(60, 140), 2), 4, 45, br)
    for name in DISTINGUISHING_FLAGS[:20]:
        add_item("Distinguishing Flag", f"Flag, Distinguishing, {name}, 3 ft x 4 ft", "8345", "EA", round(rng.uniform(180, 420), 2), 2, 60)
    for name in ORG_COLORS[:15]:
        add_item("Organizational Colors", f"Color, Organizational, {name}, 3 ft x 4 ft, embroidered", "8345", "EA", round(rng.uniform(900, 2400), 2), 1, 120)
    for war, names in STREAMERS:
        for name in names[:{"World War II": 8, "Korean War": 5, "Vietnam": 8, "Southwest Asia": 3, "Iraq": 3, "Afghanistan": 3}[war]]:
            add_item("Streamer", f"Streamer, Campaign, {war}, {name}", "8345", "EA", round(rng.uniform(28, 55), 2), 6, 30, ref="AR 840-10 / CMH lineage")
    for name in POSITIONAL_COLORS[:10]:
        add_item("Positional Color", f"Color, Positional, {name}, 4 ft 4 in x 5 ft 6 in", "8345", "EA", round(rng.uniform(400, 1100), 2), 1, 90)
    for name in AUTO_FLAGS[:6]:
        add_item("Automobile Flag", f"Flag, Automobile, {name}, 12 in x 18 in", "8345", "EA", round(rng.uniform(45, 95), 2), 2, 45)
    for name in INSIGNIA[:12]:
        add_item("Insignia", name, "8455", "PR" if "Distinctive" in name else "EA", round(rng.uniform(4, 18), 2), 200, 60, ref="AR 670-1 / TIOH")
    for name in APPURTENANCES[:7]:
        add_item("Appurtenance", name, "8345", "EA", round(rng.uniform(12, 260), 2), 4, 30)
    assert len(items) == VOLUMES["HeraldicItem"], len(items)
    active_items = [i for i in items if i.items["Active"] == "Yes"]

    # Requesters (unit POCs) ---------------------------------------------------------------------------
    requesters = []
    for i in range(VOLUMES["Requester.heraldry"]):
        u = rng.choice(units)
        fn, ln = rng.choice(FIRST_NAMES), rng.choice(SURNAMES)
        rank = rng.choice(["SGT", "SSG", "SFC", "MSG", "1SG", "CPT", "1LT", "2LT", "CW2", "MAJ", "GS-09", "GS-11"])
        role = rng.choice(["S4", "Supply Sergeant", "Property Book Officer", "Unit Commander", "Executive Officer", "Protocol Officer", "Other"])
        created = rand_dt(rng, rand_date(rng, date(2004, 2, 18), date(2026, 8, 20)))
        key = f"{u['dodaac']}~{fn[0].lower()}.{ln.lower().split('-')[0]}"
        n = db.new("Requester", created, created, [rng.choice(HERALDRY_STAFF)], {
            "RequesterKey": key, "Name": f"{fn} {ln}", "Rank": rank, "DODAAC": u["dodaac"], "UIC": u["uic"],
            "UnitName": u["name"], "Role": role, "Phone": phone(rng),
            "Email": f"{fn.lower()}.{ln.lower().split('-')[0]}.mil@example.mil", "CreatedDate": created.date(),
            "LookupKey": key.upper(),
        })
        requesters.append((n, u))

    # Requests + RequestLines -------------------------------------------------------------------------
    status_weights = [("Draft", 3), ("Submitted", 6), ("Under Review", 5), ("Approved", 8), ("Released to Vendor", 14),
                      ("In Production", 10), ("Shipped", 12), ("Complete", 37), ("Cancelled", 5)]
    released_set = {"Released to Vendor", "In Production", "Shipped", "Complete", "Cancelled"}
    doc_numbers = []
    request_docs = []
    line_count_total = 0
    for i in range(VOLUMES["Request"]):
        req, u = rng.choice(requesters)
        status = pick_weighted(rng, status_weights)
        if status in ("Draft", "Submitted", "Under Review", "Approved", "Released to Vendor", "In Production"):
            entered = business_date(rng, date(2025, 6, 1), date(2026, 8, 28))
            if rng.random() < 0.12:
                entered = business_date(rng, date(2023, 1, 1), date(2025, 5, 31))
        else:
            entered = business_date(rng, date(2004, 3, 1), date(2026, 7, 31))
        entered_dt = rand_dt(rng, entered)
        serial = rng.randint(1, 9999)
        docnum = f"{u['dodaac']}{julian(entered)}{serial:04d}"
        if rng.random() < 0.035 and doc_numbers:  # duplicate document numbers (wart #9)
            docnum = rng.choice(doc_numbers)
            dq["dup_docnumbers"] += 1
        doc_numbers.append(docnum)
        rtype = rng.choice(["Guidon", "Guidon", "Distinguishing Flag", "Organizational Colors", "Streamer", "Streamer",
                            "Positional Color", "Automobile Flag", "Insignia", "Mixed"])
        rpd = rng.choice(["02", "03", "05", "06", "09", "12", "13", "15", "15", "15"])
        vendor_key, vendor_name = "", ""
        released_by, released_dt, approved_dt, submitted_dt, reviewed_by = "", None, None, None, ""
        est_ship, cancel_reason, cancelled_dt, cancelled_by = None, "", None, ""
        history = [f"{us_date(entered)} {entered_dt:%H:%M} | (new) -> Draft | {req.items['Name']}"]
        updatedby = [f"CN={req.items['Name']}/OU=Units/O=Army"]
        revisions = [entered_dt]
        cur = entered_dt
        def step(days_lo, days_hi, label, who):
            nonlocal cur
            cur = cur + timedelta(days=rng.randint(days_lo, days_hi), hours=rng.randint(0, 6))
            if cur > AS_OF_DT:
                cur = AS_OF_DT - timedelta(hours=rng.randint(1, 48))
            history.append(f"{us_date(cur)} {cur:%H:%M} | {label} | {who.split('=')[1].split('/')[0] if '=' in who else who}")
            updatedby.append(who)
            revisions.append(cur)
            return cur
        order = ["Draft", "Submitted", "Under Review", "Approved", "Released to Vendor", "In Production", "Shipped", "Complete"]
        target_idx = order.index(status) if status != "Cancelled" else rng.randint(1, 4)
        if target_idx >= 1:
            submitted_dt = step(0, 5, "Draft -> Submitted", updatedby[0])
        if target_idx >= 2:
            reviewed_by = rng.choice(HERALDRY_STAFF)
            step(1, 10, "Submitted -> Under Review", reviewed_by)
        if target_idx >= 3:
            approved_dt = step(1, 14, "Under Review -> Approved", reviewed_by or rng.choice(HERALDRY_STAFF))
        if target_idx >= 4:
            v = rng.choice(active_vendors)
            vendor_key, vendor_name = v[0], v[1]
            if entered.year <= 2018 and rng.random() < 0.09:
                vendor_key, vendor_name = DELETED_VENDOR[0], ""  # wart #4: deleted vendor, name lookup fails
                dq["deleted_vendor_refs"] += 1
            released_by = rng.choice(HERALDRY_STAFF)
            released_dt = step(0, 7, "Approved -> Released to Vendor", released_by)
            est_ship = (released_dt + timedelta(days=rng.choice([30, 45, 60, 75, 90]))).date()
        if target_idx >= 5:
            step(3, 20, "Released to Vendor -> In Production", f"CN=Vendor Portal/O={vendor_name or 'Heraldry-Vendors'}")
        if target_idx >= 6:
            step(15, 70, "In Production -> Shipped", f"CN=Vendor Portal/O={vendor_name or 'Heraldry-Vendors'}")
        if target_idx >= 7:
            step(3, 21, "Shipped -> Complete", rng.choice(HERALDRY_STAFF))
        if status == "Cancelled":
            cancelled_by = updatedby[0] if rng.random() < 0.6 else rng.choice(HERALDRY_STAFF)
            cancel_reason = rng.choice(["Duplicate request", "Unit inactivated", "Requested in error", "Funding withdrawn",
                                        "Item obsolete - superseded by new design", "Requester separated; no longer required"])
            cancelled_dt = step(1, 30, f"{order[target_idx]} -> Cancelled", cancelled_by)
        modified = cur
        status_value = status
        if entered.year < 2009 and status in FREE_TEXT_STATUS and rng.random() < 0.35:
            status_value = rng.choice(FREE_TEXT_STATUS[status])  # wart #1
            dq["freetext_status"] += 1
        entered_value = entered
        if entered.year < 2009 and rng.random() < 0.05:
            entered_value = legacy_text_date(rng, entered)  # wart #3 (rare on heraldry side)
            dq["text_dates_heraldry"] += 1

        # lines
        nlines = pick_weighted(rng, [(1, 30), (2, 30), (3, 20), (4, 12), (5, 5), (6, 3)])
        pool = [it for it in active_items if it.items["Category"] == rtype] if rtype != "Mixed" else active_items
        if len(pool) < nlines:
            pool = active_items
        chosen = rng.sample(pool, nlines)
        lines = []
        total = 0.0
        for li, it in enumerate(chosen, 1):
            qty = rng.randint(1, max(1, min(int(it.items["MaxQtyPerRequest"]), 6)))
            if rng.random() < 0.02:
                qty = int(it.items["MaxQtyPerRequest"]) + rng.randint(1, 3)  # exceeds the per-item limit (imported before validation existed)
                dq["qty_over_limit"] += 1
            price = float(it.items["UnitPrice"])
            ext = round(qty * price, 2)
            total += ext
            line_status = {"Draft": "Open", "Submitted": "Open", "Under Review": "Open", "Approved": "Open",
                           "Released to Vendor": "Released", "In Production": "In Production", "Shipped": "Shipped",
                           "Complete": "Complete", "Cancelled": "Cancelled"}[status]
            if line_status == "In Production" and rng.random() < 0.1:
                line_status = "Backordered"
            exc = ""
            if rng.random() < 0.15:
                exc = rng.choice(["Unit designation: " + u["name"], "Embroider streamer with campaign name per CMH lineage",
                                  "Replace fringe; existing color serviceable", "Ceremony date " + us_date(rand_date(rng, entered, entered + timedelta(days=120))),
                                  "Left-hand spearhead; see attached memo"])
            lines.append({
                "ParentDocNumber": docnum, "LineNumber": li, "LineDocNumber": f"{docnum}-{li:02d}", "NSN": it.items["StockNumber"],
                "ItemKey": it.items["StockNumber"], "ItemDescription": it.items["ItemName"], "ExceptionData": exc,
                "UnitOfIssue": it.items["UnitOfIssue"], "Quantity": qty, "UnitPrice": price, "ExtendedPrice": ext,
                "LineStatus": line_status,
                "VendorShipDate": (revisions[-2].date() if line_status in ("Shipped", "Complete") and len(revisions) > 1 else None),
                "DocReaders": staff_readers + [f"DODAAC-{u['dodaac']}"] + ([vendor_key] if vendor_key else []),
                "VendorKey": vendor_key, "EnteredBy": updatedby[0], "LookupKey": f"{docnum}|{li:02d}",
            })
        readers = staff_readers + [f"DODAAC-{u['dodaac']}", updatedby[0]]
        authors = [updatedby[0], "[TACOM]"]
        if status in released_set:
            readers = staff_readers + ([vendor_key] if vendor_key else [])
            authors = ["[TACOM]", "[Admin]"]
        ship_to_self = rng.random() < 0.8
        ship_unit = u if ship_to_self else rng.choice(units)
        files = []
        if rng.random() < 0.28:
            files.append((f"DD1348-6_{docnum}.pdf", rng.randint(90000, 480000), entered_dt))
            dq["file_refs_heraldry"] += 1
        if rng.random() < 0.08:
            files.append((f"Justification_{docnum}.docx", rng.randint(20000, 90000), entered_dt))
            dq["file_refs_heraldry"] += 1
        n = db.new("Request", entered_dt, modified, updatedby, {
            "DocumentNumber": docnum, "Status": status_value, "DODAAC": u["dodaac"], "UIC": u["uic"], "UnitName": u["name"],
            "RPD": rpd, "SignalCode": rng.choice(["A", "A", "B", "J", "M"]), "FundCode": rng.choice(["2A", "2B", "2C", "6A", "6B", "AB", "GD", "XP"]),
            "ProjectCode": rng.choice(["", "", "3AH", "3AZ", "9GU", "HER"]), "SupplementaryAddress": ship_unit["dodaac"] if not ship_to_self else "",
            "RequestType": rtype, "RequiredDeliveryDate": entered + timedelta(days=rng.choice([60, 90, 120, 180])),
            "ShipToDODAAC": ship_unit["dodaac"], "ShipToName": ship_unit["name"], "ShipToAddress1": f"Bldg {rng.randint(100, 9999)}, {rng.choice(['Supply', 'S4', 'Property Book Office', 'HQ'])}",
            "ShipToAddress2": ship_unit["post"], "ShipToCity": ship_unit["post"].split(",")[-1].strip() if "," in ship_unit["post"] else ship_unit["post"],
            "ShipToState": ship_unit["state"], "ShipToZIP": f"{rng.randint(10000, 99999)}",
            "Justification": rng.choice(["Unit activation", "Change of command ceremony", "Replacement - unserviceable", "Reflagging", "Initial issue", "Deployment ceremony", "Retirement ceremony", "Lineage and honors update"]),
            "JustificationText": f"Request {rtype.lower()} items for {u['name']}. {rng.choice(['Existing items unserviceable due to fading and fraying.', 'Unit reflagged per HQDA order.', 'Ceremony scheduled; items required on hand 30 days prior.', 'Streamers authorized per CMH lineage and honors certificate dated ' + us_date(rand_date(rng, date(2003,1,1), entered)) + '.'])}",
            "LineCount": nlines, "TotalValue": round(total, 2), "EnteredDate": entered_value, "EnteredBy": updatedby[0],
            "SubmittedDate": submitted_dt, "ReviewedBy": reviewed_by, "ApprovedDate": approved_dt, "VendorKey": vendor_key,
            "VendorName": vendor_name, "ReleasedDate": released_dt, "ReleasedBy": released_by, "EstimatedShipDate": est_ship,
            "CancelReason": cancel_reason, "CancelledDate": cancelled_dt, "CancelledBy": cancelled_by, "StatusHistory": history,
            "DocReaders": readers, "DocAuthors": authors, "Priority": "Expedite" if rpd in ("02", "03", "05") else "Routine",
            "LastModifiedBy": updatedby[-1], "LastModifiedDate": modified, "StatusInquiryKey": f"{docnum}|{u['dodaac']}|{u['uic']}",
            "RequesterName": req.items["Name"], "RequesterRank": req.items["Rank"], "RequesterRole": req.items["Role"],
            "RequesterPhone": req.items["Phone"], "RequesterEmail": req.items["Email"],
        }, files=files, revisions=revisions)
        request_docs.append(n)
        for ld in lines:
            if line_count_total >= VOLUMES["RequestLine"]:
                break
            db.new("RequestLine", entered_dt + timedelta(minutes=rng.randint(1, 40)), modified, updatedby[:1] + updatedby[-1:], ld, parent=n.unid)
            line_count_total += 1
    # Orphan RequestLines (parent deleted in the Notes client without responses) - wart #5
    orphan_target = 40
    for k in range(orphan_target):
        if line_count_total >= VOLUMES["RequestLine"]:
            break
        u = rng.choice(units)
        ghost = f"{u['dodaac']}{julian(rand_date(rng, date(2005, 1, 1), date(2015, 12, 31)))}{rng.randint(1, 9999):04d}"
        it = rng.choice(items)
        created = rand_dt(rng, rand_date(rng, date(2005, 1, 1), date(2015, 12, 31)))
        db.new("RequestLine", created, created, [rng.choice(HERALDRY_STAFF)], {
            "ParentDocNumber": ghost, "LineNumber": 1, "LineDocNumber": f"{ghost}-01", "NSN": it.items["StockNumber"], "ItemKey": it.items["StockNumber"],
            "ItemDescription": it.items["ItemName"], "ExceptionData": "", "UnitOfIssue": it.items["UnitOfIssue"], "Quantity": rng.randint(1, 3),
            "UnitPrice": float(it.items["UnitPrice"]), "ExtendedPrice": float(it.items["UnitPrice"]), "LineStatus": rng.choice(["Open", "Complete", "Cancelled"]),
            "VendorShipDate": None, "DocReaders": staff_readers, "VendorKey": "", "EnteredBy": rng.choice(HERALDRY_STAFF), "LookupKey": f"{ghost}|01",
        }, parent=unid_for("heraldry", "ghost", k))
        line_count_total += 1
        dq["orphan_requestlines"] += 1
    # top up lines to volume with extra lines on random requests
    while line_count_total < VOLUMES["RequestLine"]:
        parent = rng.choice(request_docs)
        it = rng.choice(active_items)
        ln = int(parent.items["LineCount"]) + 1
        parent.items["LineCount"] = ln
        docnum = parent.items["DocumentNumber"]
        qty = rng.randint(1, 2)
        db.new("RequestLine", parent.created + timedelta(minutes=45), parent.modified, parent.updatedby[:1], {
            "ParentDocNumber": docnum, "LineNumber": ln, "LineDocNumber": f"{docnum}-{ln:02d}", "NSN": it.items["StockNumber"], "ItemKey": it.items["StockNumber"],
            "ItemDescription": it.items["ItemName"], "ExceptionData": "", "UnitOfIssue": it.items["UnitOfIssue"], "Quantity": qty,
            "UnitPrice": float(it.items["UnitPrice"]), "ExtendedPrice": round(qty * float(it.items["UnitPrice"]), 2),
            "LineStatus": "Open" if parent.items["Status"] in ("Draft", "Submitted", "Under Review", "Approved") else "Complete",
            "VendorShipDate": None, "DocReaders": parent.items["DocReaders"], "VendorKey": parent.items["VendorKey"], "EnteredBy": parent.updatedby[0], "LookupKey": f"{docnum}|{ln:02d}",
        }, parent=parent.unid)
        line_count_total += 1
    dq["dup_docnumbers_distinct"] = sum(1 for _, c in Counter(doc_numbers).items() if c > 1)

    # SES flag requests -----------------------------------------------------------------------------
    ses_status = [("Draft", 2), ("Submitted", 6), ("Returned", 4), ("Approved", 8), ("Released to Vendor", 10), ("Shipped", 8), ("Complete", 58), ("Cancelled", 4)]
    ses_orgs = ["Office of the Assistant Secretary of the Army (Acquisition, Logistics and Technology)", "Army Materiel Command G-3/4",
                "TACOM ILSC", "Army Contracting Command", "Office of the Deputy Chief of Staff, G-4", "Army Futures Command",
                "U.S. Army Corps of Engineers Headquarters", "Army Test and Evaluation Command", "Program Executive Office Ground Combat Systems",
                "Program Executive Office Soldier", "Army Sustainment Command", "Office of the Chief Information Officer/G-6"]
    for i in range(VOLUMES["SESFlagRequest"]):
        status = pick_weighted(rng, ses_status)
        entered = business_date(rng, date(2006, 1, 1), date(2026, 8, 25)) if status in ("Complete", "Cancelled", "Shipped") else business_date(rng, date(2025, 9, 1), date(2026, 8, 28))
        entered_dt = rand_dt(rng, entered)
        u = rng.choice(units)
        who = rng.choice(requesters)[0]
        tier = rng.choice(["Tier 1", "Tier 2", "Tier 2", "Tier 3", "Tier 3"])
        approved_dt = entered_dt + timedelta(days=rng.randint(2, 20)) if status in ("Approved", "Released to Vendor", "Shipped", "Complete") else None
        released_dt = (approved_dt + timedelta(days=rng.randint(1, 10))) if approved_dt and status in ("Released to Vendor", "Shipped", "Complete") else None
        modified = released_dt or approved_dt or entered_dt
        modified = min(modified + timedelta(days=rng.randint(0, 40)), AS_OF_DT) if status in ("Shipped", "Complete") else modified
        vendor = rng.choice([v for v in active_vendors if "Positional Color" in v[4] or "Automobile Flag" in v[4]])
        db.new("SESFlagRequest", entered_dt, modified, [f"CN={who.items['Name']}/OU=Units/O=Army", rng.choice(HERALDRY_STAFF)], {
            "SESFlagNumber": f"SES-{entered.year}-{i + 1:04d}", "Status": status, "ExecutiveName": f"{rng.choice(FIRST_NAMES)} {rng.choice(SURNAMES)}",
            "ExecutiveTitle": rng.choice(["Deputy to the Commanding General", "Executive Director", "Director, Integrated Logistics Support Center", "Deputy Program Executive Officer", "Principal Deputy", "Chief of Staff"]),
            "ExecutiveTier": tier, "Organization": rng.choice(ses_orgs), "FlagType": rng.choice(["SES Positional Color (Indoor)", "SES Positional Color (Indoor)", "SES Positional Color (Outdoor)", "SES Automobile Flag", "SES Desk Flag Set", "Replacement Fringe/Cord"]),
            "Quantity": 1 if rng.random() < 0.85 else 2, "DODAAC": u["dodaac"], "UIC": u["uic"],
            "ShipToAddress": f"{u['name']}, Bldg {rng.randint(100, 9999)}, {u['post']}, {u['state']}",
            "Justification": rng.choice(["New SES appointment", "Change of duty station", "Replacement - unserviceable", "Tier promotion", "Ceremony"]),
            "EnteredDate": entered, "EnteredBy": f"CN={who.items['Name']}/OU=Units/O=Army", "ApprovalDate": approved_dt,
            "ApprovedBy": "CN=Lorraine Whitcombe/OU=CHPSID/O=TACOM" if approved_dt else "", "ReturnReason": "SF-50 / appointment memo not attached" if status == "Returned" else "",
            "VendorKey": vendor[0] if released_dt else "", "ReleasedDate": released_dt,
            "DocReaders": staff_readers + ["[SESApprover]", f"CN={who.items['Name']}/OU=Units/O=Army"], "DocAuthors": ["[TACOM]", "[SESApprover]"],
            "StatusInquiryKey": f"SES-{entered.year}-{i + 1:04d}|{u['dodaac']}|{u['uic']}",
        }, files=[(f"SF50_{i + 1:04d}.pdf", rng.randint(60000, 200000), entered_dt)] if rng.random() < 0.5 else [])

    # Profile ---------------------------------------------------------------------------------------
    db.new("Profile", datetime(2004, 2, 18, 9, 0, 0), datetime(2026, 8, 31, 22, 5, 11), [ADMIN, SERVER], {
        "StatusList": ["Draft", "Submitted", "Under Review", "Approved", "Released to Vendor", "In Production", "Shipped", "Complete", "Cancelled"],
        "ReleasedStatuses": ["Released to Vendor", "In Production", "Shipped", "Complete", "Cancelled"],
        "FundCodes": ["2A", "2B", "2C", "6A", "6B", "AB", "GD", "XP"], "ProjectCodes": ["", "3AH", "3AZ", "9GU", "HER", "SES"],
        "NextRequestSerial": len(doc_numbers) + 1, "NextSESSerial": VOLUMES["SESFlagRequest"] + 1,
        "MailFrom": "Heraldry Automation System <usarmy.detroit.tacom.mbx.ilsc-heraldry@example.mil>", "MailCC": "Yes", "SendStatusMail": "Yes",
        "HelpDeskText": "Contact the Heraldry Automation System administrator, TACOM ILSC Clothing & Heraldry PSID, Philadelphia PA. DSN 444-0000 / Comm (215) 555-0100.",
        "LastOpened": datetime(2026, 8, 31, 22, 5, 11),
    })
    dq["heraldry_units"] = len(units)
    return db


# ----------------------------------------------------------------------------------------------
# vetmedals.nsf ---------------------------------------------------------------------------------
# ----------------------------------------------------------------------------------------------

def build_vetmedals(rng: random.Random, dq: dict, auth_files_out: dict) -> Db:
    db = Db("vetmedals", VET_REPLICA, "haas\\vetmedals.nsf", "Veteran Medals & Awards Case System")
    base_readers = ["[TACOM]", "[CSR]", "[Admin]", "[ReadOnlyAudit]", "LocalDomainServers"]

    # Authorization files ------------------------------------------------------------------------------
    # The last PENDING_AUTH_FILES files are the inbound batch that arrived after the most recent scheduled
    # ImportAuthorizationFile run (ImportLastRun in the Profile): their AuthorizationFile documents exist with
    # ImportStatus "Received", no cases reference them, and they are the files shipped in export/authorization-files/.
    auth_docs = []
    used_names = set()
    for i in range(VOLUMES["AuthorizationFile"]):
        src = "HRC" if i % 3 else "NPRC"
        pending = i >= VOLUMES["AuthorizationFile"] - PENDING_AUTH_FILES
        tdate = business_date(rng, date(2026, 8, 31), date(2026, 9, 1)) if pending else business_date(rng, date(2004, 3, 1), date(2026, 8, 28))
        while True:
            fname = (f"HRC_AWD_{tdate:%Y%m%d}_{rng.randint(1, 9):d}.txt" if src == "HRC" else f"nprc_awd_{tdate:%Y%m%d}_b{rng.randint(10, 99)}.dat")
            if fname not in used_names:
                break
        used_names.add(fname)
        received = rand_dt(rng, tdate, 4, 6) if not pending else datetime.combine(tdate, datetime.min.time()) + timedelta(hours=rng.randint(5, 22), minutes=rng.randint(0, 59))
        auth_docs.append({"i": i, "src": src, "date": tdate, "fname": fname, "received": received, "pending": pending, "cases": [], "lines": 0, "req_new": 0, "req_matched": 0, "rejected": 0})

    # Requesters (veterans / NOK) --------------------------------------------------------------------------
    requesters = []
    dup_of = {}
    for i in range(VOLUMES["Requester.vetmedals"]):
        make_dup = i > 50 and rng.random() < 0.08
        if make_dup:
            src_req = rng.choice(requesters[: len(requesters)])
            base = dict(src_req.items)
            variant = rng.randint(0, 4)
            ln, fn, zipc = base["LastName"], base["FirstName"], base["ZIP"]
            if variant == 0:
                fn = f"{fn} {base['MI']}" if base["MI"] else fn + " Jr"
            elif variant == 1:
                ln = ln + " Jr." if not ln.endswith("Jr.") else ln
            elif variant == 2:
                zipc = zipc[:5] if "-" in zipc else zipc + f"-{rng.randint(1000, 9999)}"
            elif variant == 3:
                fn = fn[0] + "."
            else:
                ln = ln.upper()
            rel = base["Relationship"]
            created = rand_dt(rng, rand_date(rng, src_req.created.date(), AS_OF))
            items = dict(base)
            items.update({"RequesterID": f"RQ{i + 1:06d}", "LastName": ln, "FirstName": fn, "ZIP": zipc,
                          "Source": rng.choice(["HRC", "NPRC", "Manual"]), "CreatedDate": created.date(), "AddressVerified": "No", "AddressVerifiedDate": None,
                          "LookupKey": f"{ln.upper()}|{fn.upper()}|{zipc[:5]}", "DisplayName": f"{ln}, {fn}", "MergedInto": ""})
            n = db.new("Requester", created, created, [IMPORTER if items["Source"] != "Manual" else rng.choice(CSR_USERS)], items)
            requesters.append(n)
            dup_of[n.unid] = src_req.unid
            dq["dup_requesters"] += 1
            continue
        rel = pick_weighted(rng, [(r[0], r[2]) for r in RELATIONSHIPS])
        fn, ln = rng.choice(FIRST_NAMES), rng.choice(SURNAMES)
        mi = rng.choice("ABCDEFGHJKLMNPRSTW") if rng.random() < 0.7 else ""
        street, city, st, zipc = address(rng)
        created = rand_dt(rng, rand_date(rng, date(2004, 3, 1), date(2026, 8, 28)))
        src = rng.choice(["HRC", "HRC", "NPRC", "Manual", "Congressional"])
        vet_name = f"{fn} {mi + ' ' if mi else ''}{ln}" if rel == "Self" else f"{rng.choice(FIRST_NAMES)} {ln.split('-')[0]}"
        n = db.new("Requester", created, created, [IMPORTER if src in ("HRC", "NPRC") else rng.choice(CSR_USERS)], {
            "RequesterID": f"RQ{i + 1:06d}", "LastName": ln, "Suffix": rng.choice(["", "", "", "", "Jr.", "Sr.", "III"]), "FirstName": fn, "MI": mi,
            "Relationship": rel, "VeteranName": vet_name, "Street": street, "City": city, "State": st, "ZIP": zipc,
            "Phone": phone(rng) if rng.random() < 0.8 else "", "Email": f"{fn.lower()}.{ln.lower().split('-')[0]}@example.com" if rng.random() < 0.45 else "",
            "PreferredContact": rng.choice(["Mail", "Mail", "Phone", "E-mail"]), "Source": src, "CreatedDate": created.date(),
            "AddressVerified": "Yes" if rng.random() < 0.6 else "No", "AddressVerifiedDate": created.date() if rng.random() < 0.6 else None,
            "LookupKey": f"{ln.upper()}|{fn.upper()}|{zipc[:5]}", "DisplayName": f"{ln}, {fn}{' ' + mi if mi else ''}", "DocReaders": base_readers, "MergedInto": "",
        })
        requesters.append(n)
    # a few duplicates were later merged by a CSR (MergedInto set) - most were not
    merged = 0
    for unid, src_unid in list(dup_of.items()):
        if rng.random() < 0.15:
            n = next(x for x in requesters if x.unid == unid)
            n.items["MergedInto"] = next(x for x in requesters if x.unid == src_unid).items["RequesterID"]
            merged += 1
    dq["dup_requesters_merged"] = merged

    # Awards cases + lines -------------------------------------------------------------------------------
    stage_weights = [("Closed", 78), ("Shipped", 4), ("Warehouse", 3), ("Assembly/QC", 3), ("Engraving", 3), ("Authorized", 5), ("On Hold", 1.5), ("Cancelled", 2.5)]
    era_weights = [("World War II", 22), ("Korea", 16), ("Vietnam", 30), ("Cold War", 8), ("Gulf War", 7), ("Global War on Terrorism", 12), ("Peacetime", 5)]
    stage_order = ["Authorized", "Engraving", "Assembly/QC", "Warehouse", "Shipped", "Closed"]
    case_numbers = []
    cases = []
    lines_total = 0
    eng_jobs = []
    shipments = []
    year_serial: Counter = Counter()
    eng_serial = 0
    ship_serial = 0
    for i in range(VOLUMES["AwardsCase"]):
        stage = pick_weighted(rng, stage_weights)
        if stage in ("Closed", "Cancelled"):
            entered = business_date(rng, date(2004, 3, 1), date(2026, 7, 15))
        elif stage in ("Authorized", "Engraving"):
            entered = business_date(rng, date(2026, 4, 1), date(2026, 8, 28))
        else:
            entered = business_date(rng, date(2026, 2, 1), date(2026, 8, 20))
        if stage not in ("Closed", "Cancelled") and rng.random() < 0.1:
            entered = business_date(rng, date(2025, 6, 1), date(2026, 3, 31))  # long-open, aged cases
        entered_dt = rand_dt(rng, entered)
        year_serial[entered.year] += 1
        caseno = f"VMA-{entered.year}-{year_serial[entered.year]:06d}"
        if rng.random() < 0.002 and case_numbers:
            caseno = rng.choice(case_numbers)  # wart #9
            dq["dup_casenumbers"] += 1
        case_numbers.append(caseno)
        era = pick_weighted(rng, era_weights)
        lo, hi, ylo, yhi, branches = ERA_SERVICE[era]
        svc_from = date(rng.randint(lo, hi), rng.randint(1, 12), rng.randint(1, 28))
        svc_to = svc_from + timedelta(days=365 * rng.randint(ylo, yhi) + rng.randint(0, 300))
        deceased = "Yes" if (era in ("World War II", "Korea") and rng.random() < 0.85) or (era == "Vietnam" and rng.random() < 0.45) or rng.random() < 0.1 else "No"
        req = rng.choice(requesters)
        if deceased == "Yes" and req.items["Relationship"] == "Self":
            nok = [r for r in requesters[max(0, i * 0):] if r.items["Relationship"] != "Self"]
            req = rng.choice(nok[:400]) if nok else req
        rel = req.items["Relationship"]
        if rel == "Self":
            vet_ln, vet_fn, vet_mi = req.items["LastName"], req.items["FirstName"], req.items["MI"]
        else:
            vet_ln = req.items["LastName"].split("-")[0]
            vet_fn = rng.choice(FIRST_NAMES)
            vet_mi = rng.choice("ABCDEFGHJKLMNPRSTW") if rng.random() < 0.7 else ""
        rank = rng.choice(RANKS_OFFICER) if rng.random() < 0.15 else rng.choice(RANKS_ENLISTED[:11] if era not in ("World War II", "Korea") else RANKS_ENLISTED)
        source = rng.choice(["HRC", "HRC", "HRC", "NPRC", "NPRC", "Manual", "Congressional"]) if era not in ("World War II", "Korea") else rng.choice(["NPRC", "NPRC", "NPRC", "HRC", "Congressional"])
        priority = "Congressional" if source == "Congressional" else ("Expedite" if rng.random() < 0.08 else "Routine")
        auth = rng.choice([a for a in auth_docs if a["src"] == source and not a["pending"] and a["date"] <= entered] or [None]) if source in ("HRC", "NPRC") else None
        auth_date = (auth["date"] if auth else entered - timedelta(days=rng.randint(3, 40)))
        auth_date_value = auth_date
        if entered.year < 2009 and rng.random() < 0.12:
            auth_date_value = legacy_text_date(rng, auth_date)  # wart #3
            dq["text_auth_dates"] += 1
        csr = rng.choice(CSR_USERS)
        # awards
        codes = ERA_AWARDS[era]
        nl = pick_weighted(rng, [(1, 18), (2, 32), (3, 26), (4, 14), (5, 7), (6, 3)])
        chosen = rng.sample(codes, min(nl, len(codes)))
        engravable = any(AWARD_BY_CODE[c][3] == "Yes" for c in chosen)
        # stage timeline
        history = [f"{us_date(entered)} {entered_dt:%H:%M} | (new) -> Authorized | {IMPORTER.split('=')[1].split('/')[0] if source in ('HRC', 'NPRC') else csr.split('=')[1].split('/')[0]}"]
        updatedby = [IMPORTER if source in ("HRC", "NPRC") else csr]
        revisions = [entered_dt]
        cur = entered_dt
        dates = {"EngravingDate": None, "AssemblyDate": None, "WarehouseDate": None, "ShippedDate": None, "ClosedDate": None}
        def step(days_lo, days_hi, label, who):
            nonlocal cur
            cur = cur + timedelta(days=rng.randint(days_lo, days_hi), hours=rng.randint(0, 5))
            if cur > AS_OF_DT:
                cur = AS_OF_DT - timedelta(hours=rng.randint(2, 40))
            history.append(f"{us_date(cur)} {cur:%H:%M} | {label} | {who.split('=')[1].split('/')[0]}")
            updatedby.append(who)
            revisions.append(cur)
            return cur
        path = stage_order if engravable else [s for s in stage_order if s != "Engraving"]
        if stage in stage_order:
            target = path.index(stage) if stage in path else path.index("Assembly/QC")
        elif stage == "On Hold":
            target = rng.randint(0, len(path) - 3)
        else:
            target = rng.randint(0, len(path) - 3)
        eng_job_no, qc, bin_, tracking = "", "", "", ""
        for k in range(1, target + 1):
            frm, to = path[k - 1], path[k]
            if to == "Engraving":
                step(2, 12, f"{frm} -> Engraving", rng.choice(CSR_USERS))
                dates["EngravingDate"] = cur
                eng_serial += 1
                eng_job_no = f"ENG-{cur.year}-{eng_serial:05d}"
            elif to == "Assembly/QC":
                step(3, 18, f"{frm} -> Assembly/QC", rng.choice(ENGRAVERS) if frm == "Engraving" else rng.choice(CSR_USERS))
                dates["AssemblyDate"] = cur
                qc = "Pass" if target > k or rng.random() < 0.7 else ("Fail - Rework" if rng.random() < 0.3 else "")
            elif to == "Warehouse":
                step(2, 10, f"{frm} -> Warehouse", rng.choice(ASSEMBLERS))
                dates["WarehouseDate"] = cur
                bin_ = f"{rng.choice('ABCDEFG')}-{rng.randint(1, 24):02d}-{rng.randint(1, 6)}"
            elif to == "Shipped":
                step(1, 9, f"{frm} -> Shipped", rng.choice(WAREHOUSE))
                dates["ShippedDate"] = cur
                tracking = f"9405 5{rng.randint(100, 999)} {rng.randint(1000, 9999)} {rng.randint(1000, 9999)} {rng.randint(1000, 9999)} {rng.randint(10, 99)}"
            elif to == "Closed":
                step(5, 25, f"{frm} -> Closed", rng.choice(CSR_USERS))
                dates["ClosedDate"] = cur
        hold_reason, stage_before_hold = "", ""
        if stage == "On Hold":
            stage_before_hold = path[target]
            hold_reason = rng.choice(["Awaiting NOK documentation (death certificate)", "Address returned undeliverable - contacting requester",
                                      "Award eligibility query sent to HRC", "Backorder - Purple Heart full-size out of stock", "Congressional inquiry - hold pending response",
                                      "Requester asked to hold shipment until family reunion"])
            step(1, 20, f"{stage_before_hold} -> On Hold", rng.choice(CSR_USERS))
        elif stage == "Cancelled":
            step(3, 60, f"{path[target]} -> Cancelled", rng.choice(CSR_USERS))
        modified = cur
        stage_value = stage
        if entered.year < 2009 and stage in FREE_TEXT_STAGE and rng.random() < 0.3:
            stage_value = rng.choice(FREE_TEXT_STAGE[stage])  # wart #1
            dq["freetext_stage"] += 1
        # aging (as of last night's NightlyAging run)
        open_case = stage not in ("Closed", "Cancelled")
        days_open = (AS_OF - entered).days if open_case else (dates["ClosedDate"].date() - entered).days if dates["ClosedDate"] else (modified.date() - entered).days
        days_in_stage = (AS_OF - modified.date()).days if open_case else 0
        aging = ""
        if open_case:
            aging = "Red" if days_open > AGING_RED else ("Amber" if days_open > AGING_AMBER else "")
            if aging:
                updatedby.append(SERVER)  # wart #11 - NightlyAging saves the document
                revisions.append(AS_OF_DT - timedelta(hours=4, minutes=rng.randint(0, 50)))
                history.append(f"{us_date(AS_OF - timedelta(days=1))} 02:{rng.randint(10, 59):02d} | AgingFlag -> {aging} ({days_open} days) | NightlyAging")
                dq[f"aging_{aging.lower()}"] += 1
            # every open case is touched nightly regardless
            for _ in range(min(days_open, 6)):
                updatedby.append(SERVER)
        street, city, st, zipc = req.items["Street"], req.items["City"], req.items["State"], req.items["ZIP"]
        readers = base_readers + [csr]
        n = db.new("AwardsCase", entered_dt, modified, updatedby, {
            "CaseNumber": caseno, "Stage": stage_value, "Source": source, "AuthFileName": auth["fname"] if auth else "", "AuthFileLine": (rng.randint(2, 400) if auth else None),
            "AuthorizationDate": auth_date_value, "EnteredDate": entered, "EnteredBy": updatedby[0], "Priority": priority,
            "ServiceNumber": (f"RA {rng.randint(10, 19)} {rng.randint(100, 999)} {rng.randint(100, 999)}" if era in ("Korea", "Vietnam") else f"{rng.randint(30, 39)} {rng.randint(100, 999)} {rng.randint(100, 999)}" if era == "World War II" else f"***-**-{rng.randint(1000, 9999)}"),
            "VeteranLastName": vet_ln, "VeteranFirstName": vet_fn, "VeteranMI": vet_mi, "VeteranRank": rank, "Branch": rng.choice(branches),
            "ServiceFrom": svc_from, "ServiceTo": svc_to, "Era": era, "Deceased": deceased, "RequesterKey": req.items["RequesterID"],
            "RequesterName": f"{req.items['FirstName']} {req.items['LastName']}", "Relationship": rel, "AssignedCSR": csr, "LineCount": len(chosen),
            "EngravingRequired": "Yes" if engravable else "No", "EngravingDate": dates["EngravingDate"], "EngravingJobNumber": eng_job_no,
            "AssemblyDate": dates["AssemblyDate"], "QCResult": qc, "WarehouseDate": dates["WarehouseDate"], "PickBin": bin_,
            "ShippedDate": dates["ShippedDate"], "TrackingNumber": tracking, "ClosedDate": dates["ClosedDate"], "DaysOpen": days_open,
            "AgingFlag": aging, "HoldReason": hold_reason, "StageBeforeHold": stage_before_hold, "ShipToName": f"{req.items['FirstName']} {req.items['LastName']}",
            "ShipToStreet": street, "ShipToCity": city, "ShipToState": st, "ShipToZIP": zipc,
            "Remarks": rng.choice(["", "", "", "Requester called to confirm address.", "Replacement set - originals lost in house fire per requester.", "Congressional interest - Rep. office case #" + str(rng.randint(100000, 999999)), "NOK provided DD-214 copy."]),
            "StatusHistory": history, "DocReaders": readers, "DocAuthors": ["[TACOM]", "[CSR]", "[Admin]"], "LookupKey": f"{vet_ln.upper()}|{vet_fn.upper()}|{zipc[:5]}",
            "DaysInStage": days_in_stage, "LastModifiedBy": [u for u in updatedby if u != SERVER][-1], "LastModifiedDate": modified,
            "AgingLastEval": (AS_OF_DT - timedelta(hours=4)) if open_case else None,
        }, revisions=revisions)
        cases.append(n)
        if auth:
            auth["cases"].append(n)
            auth["lines"] += len(chosen)
            if req.unid in dup_of:
                auth["req_new"] += 1
            else:
                auth["req_matched"] += 1
        # lines
        for li, code in enumerate(chosen, 1):
            if lines_total >= VOLUMES["AwardLine"] - ORPHAN_AWARDLINES:
                break
            aname, acode, acat, eng = AWARD_BY_CODE[code]
            qty = 1 if rng.random() < 0.9 else rng.randint(2, 3)
            if rng.random() < 0.004:
                qty = rng.randint(4, 6)  # over the 3-per-award limit (legacy import)
                dq["qty_over_limit_lines"] += 1
            devices = []
            if acat in ("Decoration", "Campaign Medal") and rng.random() < 0.35:
                devices = [rng.choice(["Oak Leaf Cluster (bronze)", "Bronze Service Star", "V Device", "Arrowhead"] if acat == "Decoration" else ["Bronze Service Star", "Silver Service Star", "Arrowhead"])]
            eng_text = f"{vet_fn[0]}. {vet_mi + '. ' if vet_mi else ''}{vet_ln}".upper()[:40] if eng == "Yes" else ""
            if eng == "Yes" and rng.random() < 0.03:
                eng_text = eng_text.title()  # lower case slipped past validation (pre-2011)
                dq["engraving_case_violations"] += 1
            ls_idx = {"Authorized": 0, "Engraving": 0, "Assembly/QC": 1, "Warehouse": 2, "Shipped": 4, "Closed": 4, "On Hold": 0, "Cancelled": 0}[stage]
            ls = ["Authorized", "Engraved", "Assembled", "Picked", "Shipped"][ls_idx]
            if stage == "Warehouse":
                ls = "Picked"
            if rng.random() < 0.02:
                ls = "Backordered"
            fsc = "8455"
            aname_value = aname
            if rng.random() < 0.006:
                aname_value = rng.choice(["ARCOM (unknown code X-ARC)", "BSM w/V", "Bronze Star (BSV)", "GCM 2nd Awd", "Purple Heart Medal"])  # free-text from import (wart #1)
                dq["freetext_award_names"] += 1
            db.new("AwardLine", entered_dt + timedelta(minutes=li), modified, updatedby[:1] + [u for u in updatedby if u != SERVER][-1:], {
                "ParentCaseNumber": caseno, "ParentUNID": n.unid, "VeteranName": f"{vet_ln}, {vet_fn}", "LineNumber": li, "AwardName": aname_value, "AwardCode": acode,
                "AwardCategory": acat, "Quantity": qty, "SetType": rng.choice(["Full Size", "Full Size", "Full Size + Miniature", "Full Size + Miniature + Lapel", "Ribbon Only"]) if acat in ("Decoration", "Service Medal", "Campaign Medal") else "Full Size",
                "Devices": devices, "DeviceCount": len(devices), "Engrave": eng, "EngravingText": eng_text,
                "StockNumber": f"{fsc}-00-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}", "LineStatus": ls,
                "BackorderETA": (AS_OF + timedelta(days=rng.randint(10, 60))) if ls == "Backordered" else None,
                "Authority": rng.choice(["DA Form 1577", "NPRC Form 13, item 6", "HRC Awards and Decorations Branch memo", "DD Form 214, block 13", "General Orders No. " + str(rng.randint(1, 400)) + ", " + str(svc_to.year)]),
                "DocReaders": readers, "LineKey": f"{caseno}|{li:02d}",
            }, parent=n.unid)
            lines_total += 1
        # side documents
        if eng_job_no:
            eng_jobs.append((n, eng_job_no, chosen, dates["EngravingDate"], stage, path))
        if dates["ShippedDate"]:
            shipments.append((n, dates["ShippedDate"], stage))
            if rng.random() < 0.08:
                shipments.append((n, dates["ShippedDate"] - timedelta(days=rng.randint(3, 20)), "partial"))
    # orphan AwardLines (parent deleted) - wart #5
    for k in range(ORPHAN_AWARDLINES):
        if lines_total >= VOLUMES["AwardLine"]:
            break
        y = rng.randint(2005, 2016)
        ghost = f"VMA-{y}-{rng.randint(1, 999):06d}"
        aname, acode, acat, eng = rng.choice(AWARDS)
        created = rand_dt(rng, date(y, rng.randint(1, 12), rng.randint(1, 28)))
        db.new("AwardLine", created, created, [IMPORTER], {
            "ParentCaseNumber": ghost, "ParentUNID": unid_for("vetmedals", "ghost", k), "VeteranName": f"{rng.choice(SURNAMES)}, {rng.choice(FIRST_NAMES)}", "LineNumber": 1,
            "AwardName": aname, "AwardCode": acode, "AwardCategory": acat, "Quantity": 1, "SetType": "Full Size", "Devices": [], "DeviceCount": 0, "Engrave": eng,
            "EngravingText": "", "StockNumber": f"8455-00-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}", "LineStatus": "Authorized", "BackorderETA": None,
            "Authority": "NPRC Form 13, item 6", "DocReaders": base_readers, "LineKey": f"{ghost}|01",
        }, parent=unid_for("vetmedals", "ghost", k))
        lines_total += 1
        dq["orphan_awardlines"] += 1
    # top-up lines to volume
    while lines_total < VOLUMES["AwardLine"]:
        c = rng.choice(cases)
        li = int(c.items["LineCount"]) + 1
        c.items["LineCount"] = li
        aname, acode, acat, eng = AWARD_BY_CODE[rng.choice(ERA_AWARDS[c.items["Era"]])]
        db.new("AwardLine", c.created + timedelta(minutes=li), c.modified, c.updatedby[:1], {
            "ParentCaseNumber": c.items["CaseNumber"], "ParentUNID": c.unid, "VeteranName": f"{c.items['VeteranLastName']}, {c.items['VeteranFirstName']}", "LineNumber": li,
            "AwardName": aname, "AwardCode": acode, "AwardCategory": acat, "Quantity": 1, "SetType": "Full Size", "Devices": [], "DeviceCount": 0, "Engrave": eng,
            "EngravingText": (f"{c.items['VeteranFirstName'][0]}. {c.items['VeteranLastName']}".upper() if eng == "Yes" else ""),
            "StockNumber": f"8455-00-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}", "LineStatus": "Shipped" if c.items["Stage"] in ("Shipped", "Closed") else "Authorized",
            "BackorderETA": None, "Authority": "DD Form 214, block 13", "DocReaders": c.items["DocReaders"], "LineKey": f"{c.items['CaseNumber']}|{li:02d}",
        }, parent=c.unid)
        lines_total += 1

    # Engraving jobs -------------------------------------------------------------------------------------
    rng.shuffle(eng_jobs)
    eng_jobs = eng_jobs[: VOLUMES["EngravingJob"] - 10]
    for c, jobno, chosen, qdate, stage, path in eng_jobs:
        eng_lines = [AWARD_BY_CODE[x] for x in chosen if AWARD_BY_CODE[x][3] == "Yes"]
        vet = f"{c.items['VeteranFirstName'][0]}. {c.items['VeteranMI'] + '. ' if c.items['VeteranMI'] else ''}{c.items['VeteranLastName']}".upper()
        if stage == "Engraving":
            js = rng.choice(["Queued", "Queued", "In Progress", "Rework"])
        elif stage == "On Hold" and c.items["StageBeforeHold"] == "Engraving":
            js = "Queued"
        elif stage == "Cancelled":
            js = "Cancelled"
        else:
            js = "Complete"
        started = qdate + timedelta(days=rng.randint(0, 4)) if js in ("In Progress", "Complete", "Rework") else None
        completed = (c.items["AssemblyDate"] if js == "Complete" and c.items["AssemblyDate"] else None)
        rework = 1 if js == "Rework" or (js == "Complete" and rng.random() < 0.06) else 0
        engraver = rng.choice(ENGRAVERS) if started else ""
        db.new("EngravingJob", qdate, completed or started or qdate, [rng.choice(CSR_USERS)] + ([engraver] if engraver else []), {
            "JobNumber": jobno, "CaseNumber": c.items["CaseNumber"], "VeteranName": f"{c.items['VeteranLastName']}, {c.items['VeteranFirstName']}", "JobStatus": js,
            "Priority": c.items["Priority"], "Items": [f"{a[0]} :: {vet}" for a in eng_lines] or [f"Bronze Star Medal :: {vet}"], "EngravingText": vet[:40],
            "Font": rng.choice(["Block", "Block", "Block", "Roman", "Script"]), "Machine": rng.choice(["Laser-1", "Laser-2", "Rotary-A", "Hand"]) if started else "",
            "ProofChecked": ["Spelling verified against authorization record", "Award matches line item"] if js == "Complete" else (["Spelling verified against authorization record"] if js == "In Progress" else []),
            "QueuedDate": qdate, "StartedDate": started, "CompletedDate": completed, "Engraver": engraver, "ReworkCount": rework,
            "Notes": "Rework: name misspelled on first pass - verified against DD-214." if rework else "", "DocReaders": base_readers,
            "DaysInQueue": (AS_OF - qdate.date()).days if js in ("Queued", "In Progress", "Rework") else ((completed or qdate).date() - qdate.date()).days,
        })
    # jobs referencing cases that no longer exist (archived / deleted) - wart #5
    for k in range(10):
        y = rng.randint(2012, 2019)
        qdate = rand_dt(rng, date(y, rng.randint(1, 12), rng.randint(1, 28)))
        eng_serial += 1
        db.new("EngravingJob", qdate, qdate, [rng.choice(CSR_USERS)], {
            "JobNumber": f"ENG-{y}-{eng_serial:05d}", "CaseNumber": f"VMA-{y}-{rng.randint(1, 999):06d}", "VeteranName": f"{rng.choice(SURNAMES)}, {rng.choice(FIRST_NAMES)}",
            "JobStatus": rng.choice(["Queued", "Rework"]), "Priority": "Routine", "Items": [f"Army Commendation Medal :: {rng.choice(FIRST_NAMES)[0]}. {rng.choice(SURNAMES).upper()}"],
            "EngravingText": "", "Font": "Block", "Machine": "", "ProofChecked": [], "QueuedDate": qdate, "StartedDate": None, "CompletedDate": None, "Engraver": "",
            "ReworkCount": 0, "Notes": "", "DocReaders": base_readers, "DaysInQueue": (AS_OF - qdate.date()).days,
        })
        dq["orphan_engravingjobs"] += 1

    # Shipment records ------------------------------------------------------------------------------------
    rng.shuffle(shipments)
    shipments = shipments[: VOLUMES["ShipmentRecord"] - ORPHAN_SHIPMENTS]
    live_case_numbers = {c.items["CaseNumber"] for c in cases}
    for k in range(ORPHAN_SHIPMENTS):
        # shipments whose case was archived by ArchiveClosedCases without its responses - wart #5
        y = rng.randint(2006, 2015)
        ghost_number = f"VMA-{y}-{rng.randint(1, 999):06d}"
        while ghost_number in live_case_numbers:
            ghost_number = f"VMA-{y}-{rng.randint(1, 999):06d}"
        live_case_numbers.add(ghost_number)
        ghost = SimpleNamespace(items={
            "CaseNumber": ghost_number, "Stage": "Closed", "LineCount": rng.randint(1, 4),
            "ShipToName": f"{rng.choice(FIRST_NAMES)} {rng.choice(SURNAMES)}", "ShipToStreet": f"{rng.randint(10, 9999)} {rng.choice(STREET_NAMES)} {rng.choice(STREET_TYPES)}",
            "ShipToCity": "Columbus", "ShipToState": "OH", "ShipToZIP": "43215", "TrackingNumber": ""})
        shipments.append((ghost, rand_dt(rng, date(y, rng.randint(1, 12), rng.randint(1, 28))), "orphan"))
        dq["orphan_shipments"] += 1
    for c, sdate, kind in shipments:
        ship_serial += 1
        partial = kind == "partial"
        status = "Delivered" if c.items["Stage"] == "Closed" or (c.items["Stage"] == "Shipped" and rng.random() < 0.4) else "Shipped"
        if rng.random() < 0.015:
            status = "Returned"
            dq["returned_shipments"] += 1
        carrier = rng.choice(["USPS Priority", "USPS Priority", "USPS Priority", "USPS First Class", "USPS Registered", "FedEx Ground", "UPS Ground"])
        shipped_value = sdate
        text_date = ""
        if sdate.year < 2009:
            text_date = legacy_text_date(rng, sdate.date())
            if rng.random() < 0.5:
                shipped_value = text_date  # ShippedDate itself is text on the oldest records (wart #3)
                dq["text_ship_dates"] += 1
        db.new("ShipmentRecord", sdate - timedelta(days=1), sdate + (timedelta(days=rng.randint(2, 9)) if status == "Delivered" else timedelta()), [rng.choice(WAREHOUSE)], {
            "ShipmentNumber": f"SHP-{sdate.year}-{ship_serial:06d}", "CaseNumber": c.items["CaseNumber"], "Partial": "Yes" if partial else "No",
            "ShipToName": c.items["ShipToName"], "ShipToStreet": c.items["ShipToStreet"], "ShipToCity": c.items["ShipToCity"], "ShipToState": c.items["ShipToState"], "ShipToZIP": c.items["ShipToZIP"],
            "Carrier": carrier, "TrackingNumber": c.items["TrackingNumber"] if not partial else f"9405 5{rng.randint(100, 999)} {rng.randint(1000, 9999)} {rng.randint(1000, 9999)} {rng.randint(1000, 9999)} {rng.randint(10, 99)}",
            "ShipStatus": status, "PickedDate": sdate - timedelta(days=1), "ShippedDate": shipped_value,
            "DeliveredDate": (sdate + timedelta(days=rng.randint(2, 9))) if status == "Delivered" else None,
            "Contents": f"{c.items['LineCount']} award line(s) for case {c.items['CaseNumber']}" + (" (partial - backordered items to follow)" if partial else ""),
            "PieceCount": 1 if rng.random() < 0.9 else 2, "WeightOz": rng.randint(6, 48), "ShippedBy": rng.choice(WAREHOUSE),
            "Postage": round(rng.uniform(4.5, 21.9), 2), "ExceptionNote": "Returned - insufficient address" if status == "Returned" else "",
            "DocReaders": base_readers, "ShipDateText": text_date,
        })

    # Case notes ---------------------------------------------------------------------------------------------
    for k in range(VOLUMES["CaseNote"]):
        c = rng.choice(cases)
        nd = c.created + timedelta(days=rng.randint(0, max(1, (c.modified - c.created).days)), hours=rng.randint(0, 8))
        ntype = rng.choice(["Phone Call - Inbound", "Phone Call - Inbound", "Phone Call - Outbound", "Congressional Inquiry", "HRC Query", "NPRC Query", "Address Correction", "NOK Documentation", "QC Rework", "Backorder", "General"])
        author = rng.choice(CSR_USERS)
        summary = {"Phone Call - Inbound": "Requester called for status", "Phone Call - Outbound": "Called requester to confirm address",
                   "Congressional Inquiry": "Congressional inquiry received - response due 10 days", "HRC Query": "Sent eligibility query to HRC Awards Branch",
                   "NPRC Query": "Requested OMPF verification from NPRC", "Address Correction": "Address updated per requester",
                   "NOK Documentation": "Death certificate / relationship proof received", "QC Rework": "QC failed - engraving misspelled, returned to shop",
                   "Backorder": "Item backordered - requester notified", "General": "General note"}[ntype]
        db.new("CaseNote", nd, nd, [author], {
            "ParentCaseNumber": c.items["CaseNumber"], "ParentUNID": c.unid, "NoteType": ntype, "ContactName": c.items["RequesterName"] if "Call" in ntype else "",
            "ContactPhone": phone(rng) if "Call" in ntype else "", "Body": f"{summary}. {rng.choice(['No further action.', 'Follow-up required.', 'Requester satisfied.', 'Escalated to lead CSR.', 'See attached correspondence.'])}",
            "Summary": summary, "FollowUpDate": (nd + timedelta(days=rng.randint(3, 14))).date() if rng.random() < 0.3 else None,
            "FollowUpDone": ["Yes"] if rng.random() < 0.7 else [], "NoteAuthor": author, "NoteDate": nd, "DocReaders": c.items["DocReaders"], "DocAuthors": [author, "[Admin]"],
        }, parent=c.unid, files=[(f"Correspondence_{c.items['CaseNumber']}.pdf", rng.randint(40000, 300000), nd)] if rng.random() < 0.1 else [])

    # AuthorizationFile documents ---------------------------------------------------------------------------
    sample_names = []
    for a in auth_docs:
        nrec = len(a["cases"]) + a["lines"] + 2
        status = "Imported"
        rejected = 0
        if a["i"] % 7 == 3:
            status = "Imported with Errors"
            rejected = rng.randint(1, 6)
        if a["i"] == 11:
            status = "Rejected"
            rejected = nrec
        missing_file = a["i"] % 9 == 5  # $FILE item references an attachment that is no longer in the note (wart #6)
        files = [] if missing_file else [(a["fname"], 60 + nrec * (216 if a["src"] == "HRC" else 140), a["received"])]
        if missing_file:
            dq["missing_file_refs"] += 1
        imported = a["received"] + timedelta(minutes=rng.randint(5, 90))
        log = [f"{imported:%m/%d/%Y %H:%M} Import started by {IMPORTER}", f"{imported:%m/%d/%Y %H:%M} {len(a['cases'])} case record(s), {a['lines']} award record(s)"]
        if rejected:
            log.append(f"{imported:%m/%d/%Y %H:%M} {rejected} record(s) rejected - see ImportLog detail")
        log.append(f"{imported:%m/%d/%Y %H:%M} Import finished: {status}")
        if a["pending"]:
            status, rejected, nrec, missing_file = "Received", 0, 0, False
            files = [(a["fname"], 60 + 30 * (216 if a["src"] == "HRC" else 140), a["received"])]
            imported = a["received"]
            log = [f"{a['received']:%m/%d/%Y %H:%M} File received in \\\\haas-app01\\hrc_transfer\\inbound by {IMPORTER}",
                   f"{a['received']:%m/%d/%Y %H:%M} Awaiting scheduled ImportAuthorizationFile run (daily 04:15) or manual run from the Agents menu"]
        n = db.new("AuthorizationFile", a["received"], imported, [IMPORTER], {
            "FileName": a["fname"], "SourceAgency": a["src"], "Layout": "HRC-FIXED" if a["src"] == "HRC" else "NPRC-DELIM", "TransmissionDate": a["date"],
            "ReceivedDate": a["received"], "AuthorizationDate": a["date"] - timedelta(days=rng.randint(1, 5)), "ImportStatus": status,
            "ImportedDate": "" if a["pending"] else imported, "ImportedBy": "" if a["pending"] else IMPORTER, "RecordCount": nrec, "CasesCreated": len(a["cases"]) if status != "Rejected" else 0,
            "LinesCreated": a["lines"] if status != "Rejected" else 0, "RequestersCreated": a["req_new"], "RequestersMatched": a["req_matched"], "RecordsRejected": rejected,
            "TrailerChecksum": "" if a["pending"] else ("N/A" if a["src"] == "NPRC" else ("No" if status == "Rejected" else "Yes")),
            "ChecksumMatch": "" if a["pending"] else ("N/A" if a["src"] == "NPRC" else ("No" if status == "Rejected" else "Yes")),
            "ImportLog": log, "DocReaders": ["[Importer]", "[Admin]", "[TACOM]", "[ReadOnlyAudit]", "LocalDomainServers"], "FileKey": a["fname"].upper(),
        }, files=files)
        a["note"] = n
        dq["file_refs_vetmedals"] += len(files)
    # the pending inbound files are the ones shipped as sample files in export/authorization-files/
    for a in auth_docs[-PENDING_AUTH_FILES:]:
        sample_names.append(a)
    auth_files_out["samples"] = sample_names
    auth_files_out["cases"] = cases

    db.new("Profile", datetime(2004, 2, 18, 9, 30, 0), datetime(2026, 8, 31, 4, 18, 40), [ADMIN, SERVER], {
        "StageList": stage_order + ["On Hold", "Cancelled"], "AgingAmberDays": AGING_AMBER, "AgingRedDays": AGING_RED,
        "Awards": [f"{a[0]}|{a[1]}|{a[2]}|{a[3]}" for a in AWARDS], "NextCaseSerial": year_serial[2026] + 1, "NextRequesterSerial": VOLUMES["Requester.vetmedals"] + 1,
        "NextEngravingSerial": eng_serial + 1, "NextShipmentSerial": ship_serial + 1, "ImportPath": "\\\\haas-app01\\hrc_transfer\\inbound", "ImportArchive": "Yes",
        "ArchiveAfterDays": 730, "ArchiveDbPath": "haas\\archive\\vetmedals_arch.nsf", "MailFrom": "usarmy.detroit.tacom.mbx.chpsid-awards@example.mil",
        "AgingReportTo": "TACOM-CHPSID-Awards-CSR", "AgingLastRun": datetime(2026, 8, 31, 2, 0, 4), "ArchiveLastRun": datetime(2026, 8, 30, 1, 0, 2), "ImportLastRun": datetime(2026, 8, 31, 4, 15, 9),
        "HelpDeskText": "For assistance contact the TACOM Clothing & Heraldry PSID Awards Customer Service line, 0800-1600 ET, Mon-Fri.",
    })
    dq["cases_open"] = sum(1 for c in cases if c.items["Stage"] not in ("Closed", "Cancelled") and c.items["Stage"] in stage_order + ["On Hold"])
    return db


# ----------------------------------------------------------------------------------------------
# Authorization files (HRC fixed-width, NPRC pipe-delimited) ------------------------------------
# ----------------------------------------------------------------------------------------------

def fw(s: str, n: int) -> str:
    s = "" if s is None else str(s)
    return s[:n].ljust(n)


REL_CODE = {r[0]: r[1] for r in RELATIONSHIPS}


def hrc_file(rng: random.Random, a: dict, cases: list[Note], defects: bool) -> str:
    lines = []
    fdate = a["date"].strftime("%Y%m%d")
    adate = (a["date"] - timedelta(days=2)).strftime("%Y%m%d")
    recs = []
    checksum = 0
    ncase = nawd = 0
    for c in cases:
        ref = f"H{c.created:%y}{rng.randint(1000000, 9999999):07d}"[:10]
        checksum += sum(int(ch) for ch in ref if ch.isdigit())
        it = c.items
        recs.append("10" + fw(ref, 10) + fw(it["VeteranLastName"], 30) + fw(it["VeteranFirstName"], 20) + fw(it["VeteranMI"], 1)
                    + fw(it["ServiceNumber"][-4:] if "*" in it["ServiceNumber"] else it["ServiceNumber"].replace(" ", "")[-4:], 8).rjust(8)
                    + fw(it["ServiceFrom"].strftime("%Y%m%d"), 8) + fw(it["ServiceTo"].strftime("%Y%m%d"), 8) + fw(REL_CODE.get(it["Relationship"], "OT"), 2)
                    + fw(it["RequesterName"].split(" ", 1)[1] if " " in it["RequesterName"] else it["RequesterName"], 30) + fw(it["RequesterName"].split(" ")[0], 20)
                    + fw(it["ShipToStreet"], 30) + fw(it["ShipToCity"], 20) + fw(it["ShipToState"], 2) + fw(it["ShipToZIP"], 10)
                    + ("Y" if it["Deceased"] == "Yes" else "N") + {"Routine": "R", "Expedite": "E", "Congressional": "C"}[it["Priority"]] + fw(it["VeteranRank"], 12))
        ncase += 1
        codes = rng.sample(ERA_AWARDS[it["Era"]], min(int(it["LineCount"]), len(ERA_AWARDS[it["Era"]])))
        for code in codes:
            aname, acode, acat, eng = AWARD_BY_CODE[code]
            qty = 1
            text = f"{it['VeteranFirstName'][0]}. {it['VeteranLastName']}".upper() if eng == "Yes" else ""
            recs.append("20" + fw(ref, 10) + fw(acode, 6) + f"{qty:02d}" + f"{rng.randint(0, 2):02d}" + eng[0] + fw(text, 40) + fw("HRC Awards and Decorations Branch", 30))
            nawd += 1
    if defects:
        # unknown award code, quantity over limit, award record for a case id that is not in the file, duplicate case record
        recs.append("20" + fw(recs[0][2:12], 10) + fw("XQZ", 6) + "01" + "00" + "N" + fw("", 40) + fw("HRC Awards and Decorations Branch", 30))
        recs.append("20" + fw("H26ZZZ0001", 10) + fw("PH", 6) + "01" + "00" + "N" + fw("", 40) + fw("HRC Awards and Decorations Branch", 30))
        recs.insert(3, "20" + recs[1][2:12] + fw("BSM", 6) + "05" + "00" + "Y" + fw("TEST QTY OVER LIMIT", 40) + fw("HRC Awards and Decorations Branch", 30))
        recs.append(recs[0])
        recs.append("30" + fw("UNKNOWN RECORD TYPE", 60))
        nawd += 2
        ncase += 1
    batch = "HRC" + a["fname"].split("_")[3].split(".")[0].zfill(5)
    lines.append("01" + fdate + fw(batch, 8) + adate + f"{len(recs):06d}")
    lines.extend(recs)
    lines.append("99" + f"{ncase:06d}" + f"{nawd:06d}" + f"{(checksum + (7 if defects else 0)) % 99999999:08d}")
    return "\r\n".join(lines) + "\r\n"


def nprc_file(rng: random.Random, a: dict, cases: list[Note], defects: bool) -> str:
    lines = [f"NPRC-AWD|v2|{a['date']:%Y-%m-%d}|{a['fname'].split('_')[3].split('.')[0].upper()}|{a['date'] - timedelta(days=3):%Y-%m-%d}"]
    ncase = nawd = 0
    for c in cases:
        it = c.items
        ref = f"N{rng.randint(10000000, 99999999)}"
        req_last, req_first = (it["RequesterName"].split(" ", 1)[1], it["RequesterName"].split(" ")[0]) if " " in it["RequesterName"] else (it["RequesterName"], "")
        lines.append("|".join(["C", ref, it["VeteranLastName"], it["VeteranFirstName"], it["VeteranMI"], it["ServiceNumber"][-4:],
                               it["ServiceFrom"].strftime("%Y-%m-%d"), it["ServiceTo"].strftime("%Y-%m-%d"), REL_CODE.get(it["Relationship"], "OT"),
                               req_last, req_first, it["ShipToStreet"], it["ShipToCity"], it["ShipToState"], it["ShipToZIP"], "Y" if it["Deceased"] == "Yes" else "N",
                               {"Routine": "R", "Expedite": "E", "Congressional": "C"}[it["Priority"]], it["VeteranRank"]]))
        ncase += 1
        for code in rng.sample(ERA_AWARDS[it["Era"]], min(int(it["LineCount"]), len(ERA_AWARDS[it["Era"]]))):
            aname, acode, acat, eng = AWARD_BY_CODE[code]
            text = f"{it['VeteranFirstName'][0]}. {it['VeteranLastName']}".upper() if eng == "Yes" else ""
            lines.append("|".join(["A", ref, acode, "1", str(rng.randint(0, 2)), eng[0], text, "NPRC Form 13, item 6"]))
            nawd += 1
    if defects:
        lines.append("A|N00000000|PH|1|0|Y|ORPHAN AWARD RECORD|NPRC Form 13, item 6")  # award for unknown case
        lines.append(lines[1])  # duplicate case record
        lines.append("C|N99999999|MALFORMED")  # short record
        nawd += 1
        ncase += 2
    lines.append(f"T|{ncase}|{nawd}")
    return "\n".join(lines) + "\n"


def write_auth_files(rng: random.Random, outdir: str, info: dict, dq: dict):
    samples = info["samples"]
    written = []
    for idx, a in enumerate(samples):
        cases = a["cases"][:12] if a["cases"] else rng.sample(info["cases"], 8)
        defects = idx in (1, 3)
        body = hrc_file(rng, a, cases, defects) if a["src"] == "HRC" else nprc_file(rng, a, cases, defects)
        path = os.path.join(outdir, a["fname"])
        with open(path, "w", encoding="ascii", newline="") as f:
            f.write(body)
        written.append((a["fname"], a["src"], len(cases), defects))
    dq["auth_files"] = written
    with open(os.path.join(outdir, "README.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("# Sample authorization files\n\n")
        f.write("Generated by `tools/generate_fixtures.py`. Each file corresponds to an `AuthorizationFile` document in\n"
                "`export/dxl/vetmedals-documents.dxl` (matched on `FileName`) whose `ImportStatus` is `Received`: these are the\n"
                "inbound batch that arrived after the last scheduled import, so `ImportAuthorizationFile` (LotusScript in\n"
                "`nsf/vetmedals.nsf/agents/`, JavaScript port in `harness/lib/agents.js`) will process them when run from\n"
                "the harness Agents menu. The veteran and next-of-kin names deliberately overlap earlier cases so the importer's\n"
                "requester de-duplication is exercised.\n\n")
        f.write("| File | Layout | Case records | Intentional defects |\n|---|---|---|---|\n")
        for fname, src, n, defects in written:
            f.write(f"| `{fname}` | {'HRC fixed-width (01/10/20/99)' if src == 'HRC' else 'NPRC pipe-delimited (C/A/T)'} | {n} | "
                    f"{'unknown award code, qty > 3, orphan award record, duplicate case record, unknown record type, trailer checksum off by 7' if defects and src == 'HRC' else 'orphan award record, duplicate case record, malformed short record' if defects else 'none'} |\n")
        f.write("\nLayouts are documented at the top of `nsf/vetmedals.nsf/agents/ImportAuthorizationFile.lss`.\n")


# ----------------------------------------------------------------------------------------------
# Data-quality notes ---------------------------------------------------------------------------
# ----------------------------------------------------------------------------------------------

def write_dq_notes(path: str, her: Db, vet: Db, dq: dict):
    def c(db: Db, form: str) -> int:
        return db.counter[form]
    her_req = [n for n in her.notes if n.form == "Request"]
    vet_cases = [n for n in vet.notes if n.form == "AwardsCase"]
    status_variants = Counter(n.items["Status"] for n in her_req)
    stage_variants = Counter(n.items["Stage"] for n in vet_cases)
    canon_status = {"Draft", "Submitted", "Under Review", "Approved", "Released to Vendor", "In Production", "Shipped", "Complete", "Cancelled"}
    canon_stage = {"Authorized", "Engraving", "Assembly/QC", "Warehouse", "Shipped", "Closed", "On Hold", "Cancelled"}
    text_dates_case = sum(1 for n in vet_cases if isinstance(n.items["AuthorizationDate"], str))
    vet_ship = [n for n in vet.notes if n.form == "ShipmentRecord"]
    her_lines = [n for n in her.notes if n.form == "RequestLine"]
    vet_lines = [n for n in vet.notes if n.form == "AwardLine"]
    req_unids = {n.unid for n in her_req}
    case_unids = {n.unid for n in vet_cases}
    case_numbers = {n.items["CaseNumber"] for n in vet_cases}
    orphan_rl = sum(1 for n in her_lines if n.parent not in req_unids)
    orphan_al = sum(1 for n in vet_lines if n.parent not in case_unids)
    orphan_ej = sum(1 for n in vet.notes if n.form == "EngravingJob" and n.items["CaseNumber"] not in case_numbers)
    deleted_vendor = sum(1 for n in her_req if n.items["VendorKey"] == DELETED_VENDOR[0])
    dup_doc = Counter(n.items["DocumentNumber"] for n in her_req)
    dup_case = Counter(n.items["CaseNumber"] for n in vet_cases)
    files_her = sum(len(n.files) for n in her.notes)
    files_vet = sum(len(n.files) for n in vet.notes)
    vet_reqs = [n for n in vet.notes if n.form == "Requester"]
    key_counts = Counter(n.items["LookupKey"] for n in vet_reqs)
    same_key_dups = sum(c_ - 1 for c_ in key_counts.values() if c_ > 1)
    agent_updated = sum(1 for n in vet_cases if SERVER in n.updatedby)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("# Data-quality notes for the HAAS synthetic export\n\n")
        f.write(f"Generated by `tools/generate_fixtures.py` (seed {SEED}, export as of {AS_OF.isoformat()}). Every number below is\n"
                "counted from the generated documents, so the migration side can prove each defect was detected and fixed.\n"
                "Wart numbers refer to `nsf/README-design.md` section 5.\n\n")
        f.write("## Volumes\n\n| Database | Form | Documents |\n|---|---|---|\n")
        for db in (her, vet):
            for form, cnt in sorted(db.counter.items()):
                f.write(f"| {db.key}.nsf | {form} | {cnt:,} |\n")
        f.write(f"| heraldry.nsf | *total* | {len(her.notes):,} |\n| vetmedals.nsf | *total* | {len(vet.notes):,} |\n\n")
        f.write("## Intentional defects\n\n")
        f.write(f"### 1. Free-text status / stage values (wart #1)\n\n"
                f"* `Request.Status`: {sum(v for k, v in status_variants.items() if k not in canon_status)} documents carry a non-keyword value "
                f"({len([k for k in status_variants if k not in canon_status])} distinct variants). Variants and counts:\n")
        for k, v in sorted(status_variants.items()):
            if k not in canon_status:
                f.write(f"  * `{k}`: {v}\n")
        f.write(f"* `AwardsCase.Stage`: {sum(v for k, v in stage_variants.items() if k not in canon_stage)} documents carry a non-keyword value:\n")
        for k, v in sorted(stage_variants.items()):
            if k not in canon_stage:
                f.write(f"  * `{k}`: {v}\n")
        f.write(f"* `AwardLine.AwardName` free-text (unknown import code kept as name): {dq['freetext_award_names']}\n\n")
        f.write(f"### 2. Duplicated requester documents (wart #2)\n\n"
                f"* vetmedals `Requester`: {dq['dup_requesters']} of {len(vet_reqs):,} documents ({dq['dup_requesters'] / len(vet_reqs):.1%}) were generated as a "
                f"variant of an existing requester (suffix, middle initial in first name, ZIP+4 vs ZIP5, initial-only first name, upper-cased surname).\n"
                f"* Of those, {same_key_dups} share an identical `LookupKey` with another document (the dedupe key failed to prevent them), and "
                f"{dq['dup_requesters_merged']} were later marked `MergedInto` by a CSR; the remainder are live duplicates.\n\n")
        f.write(f"### 3. Mixed date formats (wart #3)\n\n"
                f"* `AwardsCase.AuthorizationDate` stored as text: {text_dates_case} (shapes `M/D/YYYY`, `YYYY-MM-DD`, `DD MON YY`, `YYYYMMDD`)\n"
                f"* `ShipmentRecord.ShippedDate` stored as text: {sum(1 for n in vet_ship if isinstance(n.items['ShippedDate'], str))}; "
                f"`ShipDateText` populated on {sum(1 for n in vet_ship if n.items['ShipDateText'])} records\n"
                f"* `Request.EnteredDate` stored as text: {sum(1 for n in her_req if isinstance(n.items['EnteredDate'], str))}\n\n")
        f.write(f"### 4. Deleted-but-referenced vendor (wart #4)\n\n"
                f"* Vendor `{DELETED_VENDOR[0]}` ({DELETED_VENDOR[1]}) has no `Vendor` document. Referenced by `Request.VendorKey` on {deleted_vendor} requests "
                f"(all with empty `VendorName`) and by {sum(1 for n in her_lines if n.items['VendorKey'] == DELETED_VENDOR[0])} `RequestLine` documents.\n"
                f"* Vendor `1PRQ2` exists but is `Active = No`; still referenced by {sum(1 for n in her_req if n.items['VendorKey'] == '1PRQ2')} requests.\n\n")
        f.write(f"### 5. Orphaned child documents (wart #5)\n\n"
                f"* `RequestLine` whose parent UNID is not in the export: {orphan_rl}\n"
                f"* `AwardLine` whose parent UNID is not in the export: {orphan_al}\n"
                f"* `EngravingJob` whose `CaseNumber` matches no `AwardsCase`: {orphan_ej}\n"
                f"* `ShipmentRecord` whose `CaseNumber` matches no `AwardsCase`: {sum(1 for n in vet_ship if n.items['CaseNumber'] not in case_numbers)}\n\n")
        f.write(f"### 6. `$FILE` attachment references (wart #6)\n\n"
                f"* heraldry.nsf `$FILE` items: {files_her} (scanned DD1348-6 PDFs, justification memos, SF-50s). Binary content is not in the export.\n"
                f"* vetmedals.nsf `$FILE` items: {files_vet} (raw authorization transmissions, correspondence).\n"
                f"* `AuthorizationFile` documents whose `FileBody` should hold an attachment but have no `$FILE` item: {dq['missing_file_refs']}\n"
                f"* Only the {len(dq['auth_files'])} files in `export/authorization-files/` exist as real bytes.\n\n")
        f.write(f"### 9. Non-unique business keys (wart #9)\n\n"
                f"* Duplicate `Request.DocumentNumber`: {sum(v - 1 for v in dup_doc.values() if v > 1)} extra documents across {sum(1 for v in dup_doc.values() if v > 1)} numbers\n"
                f"* Duplicate `AwardsCase.CaseNumber`: {sum(v - 1 for v in dup_case.values() if v > 1)} extra documents\n\n")
        f.write(f"### 11. `$UpdatedBy` polluted by the agent signer (wart #11)\n\n"
                f"* `AwardsCase` documents whose `$UpdatedBy` contains `{SERVER}`: {agent_updated} (every open case is saved nightly by `NightlyAging`).\n\n")
        f.write("### Other\n\n"
                f"* `RequestLine.Quantity` above `HeraldicItem.MaxQtyPerRequest` (imported before validation existed): {dq['qty_over_limit']}\n"
                f"* `AwardLine.Quantity` above 3: {dq['qty_over_limit_lines']}\n"
                f"* `AwardLine.EngravingText` not upper case (pre-2011 validation gap): {dq['engraving_case_violations']}\n"
                f"* `ShipmentRecord.ShipStatus = Returned`: {dq['returned_shipments']}\n"
                f"* Open awards cases: {dq['cases_open']} - `AgingFlag` Amber: {dq['aging_amber']}, Red: {dq['aging_red']} (thresholds {AGING_AMBER}/{AGING_RED} days as of {AS_OF.isoformat()})\n\n")
        f.write("## Synthetic-data statement\n\n"
                "All personal names are drawn from a constructed surname list; addresses combine real city/state/ZIP3 prefixes with generated\n"
                "street numbers and names; service numbers and SSN fragments are random. Unit designations, installations, medal names and\n"
                "campaign streamer names are real public information. No record describes a real person.\n")


# ----------------------------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "export"))
    args = ap.parse_args(argv)
    out = args.out
    for sub in ("dxl", "csv", "authorization-files"):
        os.makedirs(os.path.join(out, sub), exist_ok=True)
    dq: Counter = Counter()
    rng = random.Random(SEED)
    her = build_heraldry(rng, dq)
    info: dict = {}
    vet = build_vetmedals(rng, dq, info)
    write_dxl(her, os.path.join(out, "dxl", "heraldry-documents.dxl"))
    write_dxl(vet, os.path.join(out, "dxl", "vetmedals-documents.dxl"))
    for old in os.listdir(os.path.join(out, "csv")):
        os.remove(os.path.join(out, "csv", old))
    write_csvs(her, os.path.join(out, "csv"))
    write_csvs(vet, os.path.join(out, "csv"))
    for old in os.listdir(os.path.join(out, "authorization-files")):
        os.remove(os.path.join(out, "authorization-files", old))
    write_auth_files(rng, os.path.join(out, "authorization-files"), info, dq)
    write_dq_notes(os.path.join(out, "DATA-QUALITY-NOTES.md"), her, vet, dq)
    print(f"heraldry.nsf: {len(her.notes):,} documents  {dict(sorted(her.counter.items()))}")
    print(f"vetmedals.nsf: {len(vet.notes):,} documents  {dict(sorted(vet.counter.items()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
