/**
 * GSC -> Slack SEO Alert Automation
 * ---------------------------------
 * Monitors Google Search Console performance for multiple SEO projects and
 * posts alerts to Slack (via Incoming Webhooks) when clicks, impressions, CTR,
 * or average position move beyond configured thresholds.
 *
 * Stack: Google Apps Script + Google Sheets (config/log) + GSC Search Analytics
 *        API + Slack Incoming Webhooks. No Zapier.
 *
 * Setup: run setupSheets() once, fill in the Projects sheet, then
 *        createDailyTrigger(). See README.md for full instructions.
 */

// ============================ CONFIG CONSTANTS ============================

var SHEET_PROJECTS = 'Projects';
var SHEET_LOG      = 'Alert Log';
var SHEET_SETTINGS = 'Settings';

var PROJECTS_HEADERS = [
  'Project Name', 'GSC Property URL', 'Slack Webhook URL', 'Status',
  'Click Drop Threshold %', 'Impression Drop Threshold %', 'CTR Drop Threshold %',
  'Position Worsening Threshold', 'Check Type', 'Notes'
];

var LOG_HEADERS = [
  'Timestamp', 'Project Name', 'Alert Type', 'Current Period', 'Previous Period',
  'Current Clicks', 'Previous Clicks', 'Click Change %',
  'Current Impressions', 'Previous Impressions', 'Impression Change %',
  'Current CTR', 'Previous CTR', 'CTR Change %',
  'Current Avg Position', 'Previous Avg Position', 'Position Change',
  'Slack Sent', 'Notes'
];

var SETTINGS_HEADERS = ['Setting', 'Value'];

// Column indexes into the Alert Log (0-based) used by alreadyAlerted().
var LOG_COL_PROJECT       = 1;
var LOG_COL_ALERT_TYPE    = 2;
var LOG_COL_CURRENT_PERIOD = 3;
var LOG_COL_SLACK_SENT    = 17;

// Sensible built-in defaults (used if the Settings sheet is missing values).
var DEFAULTS = {
  dataDelayDays: 3,
  comparisonWindowDays: 7,
  minClicks: 10,
  minImpressions: 100,
  enablePageAlerts: true,
  enableQueryAlerts: false,
  // Per-project threshold fallbacks when a Projects cell is left blank.
  clickDropThreshold: 30,
  impressionDropThreshold: 30,
  ctrDropThreshold: 25,
  positionThreshold: 3,
  // Page-level alert rule.
  pageDropThreshold: 25,
  pageMinPrevClicks: 5
};

// ============================ SPREADSHEET MENU ============================

/**
 * Adds a convenience menu when the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('GSC Alerts')
    .addItem('1. Setup sheets', 'setupSheets')
    .addItem('2. Run alerts now', 'runGscSlackAlerts')
    .addItem('3. Create daily trigger', 'createDailyTrigger')
    .addToUi();
}

// ============================ SHEET SETUP ============================

/**
 * Creates the Projects, Alert Log, and Settings tabs (with headers) if they
 * do not already exist, and seeds example rows / default settings. Safe to
 * re-run: it will not overwrite existing data.
 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- Projects ---
  var projects = ensureSheet_(ss, SHEET_PROJECTS, PROJECTS_HEADERS);
  if (projects.getLastRow() < 2) {
    projects.appendRow(["Quincy's Air", 'https://quincysair.com/', '', 'active',
      30, 30, 25, 3, 'both', 'Example - replace with real property + webhook']);
    projects.appendRow(['ExpoTraffic', 'sc-domain:expotraffic.com', '', 'active',
      30, 30, 25, 3, 'both', 'Example - replace with real property + webhook']);
  }

  // --- Alert Log ---
  ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);

  // --- Settings ---
  var settings = ensureSheet_(ss, SHEET_SETTINGS, SETTINGS_HEADERS);
  if (settings.getLastRow() < 2) {
    var rows = [
      ['Data Delay Days', 3],
      ['Comparison Window Days', 7],
      ['Minimum Clicks Before Alert', 10],
      ['Minimum Impressions Before Alert', 100],
      ['Enable Page Level Alerts', 'yes'],
      ['Enable Query Level Alerts', 'no']
    ];
    settings.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('Sheets ready. Fill in the Projects tab, then run alerts.', 'GSC Alerts', 5);
}

/**
 * Returns a sheet by name, creating it if needed, and guarantees the header
 * row matches the expected headers.
 */
function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  return sheet;
}

// ============================ CONFIG READERS ============================

/**
 * Reads active projects from the Projects sheet. Blank threshold cells fall
 * back to DEFAULTS. Only rows with Status = "active" are returned.
 */
function getProjects() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROJECTS);
  if (!sheet) throw new Error('Projects sheet not found. Run setupSheets() first.');

  var data = sheet.getDataRange().getValues();
  if (data.length < 1 || String(data[0][0]).trim() !== 'Project Name') {
    throw new Error('Projects sheet header is broken. Re-run setupSheets().');
  }
  if (data.length < 2) return [];

  var out = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    if (String(row[3] || '').toLowerCase().trim() !== 'active') continue;
    out.push({
      name: String(row[0]).trim(),
      siteUrl: String(row[1] || '').trim(),
      webhookUrl: String(row[2] || '').trim(),
      status: 'active',
      clickDropThreshold: num_(row[4], DEFAULTS.clickDropThreshold),
      impressionDropThreshold: num_(row[5], DEFAULTS.impressionDropThreshold),
      ctrDropThreshold: num_(row[6], DEFAULTS.ctrDropThreshold),
      positionThreshold: num_(row[7], DEFAULTS.positionThreshold),
      checkType: String(row[8] || 'both').toLowerCase().trim(),
      notes: row[9] || ''
    });
  }
  return out;
}

/**
 * Reads global settings from the Settings sheet, falling back to DEFAULTS.
 */
function getSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) {
    return {
      dataDelayDays: DEFAULTS.dataDelayDays,
      comparisonWindowDays: DEFAULTS.comparisonWindowDays,
      minClicks: DEFAULTS.minClicks,
      minImpressions: DEFAULTS.minImpressions,
      enablePageAlerts: DEFAULTS.enablePageAlerts,
      enableQueryAlerts: DEFAULTS.enableQueryAlerts
    };
  }
  var data = sheet.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) map[String(data[i][0]).trim()] = data[i][1];
  }
  return {
    dataDelayDays: num_(map['Data Delay Days'], DEFAULTS.dataDelayDays),
    comparisonWindowDays: num_(map['Comparison Window Days'], DEFAULTS.comparisonWindowDays),
    minClicks: num_(map['Minimum Clicks Before Alert'], DEFAULTS.minClicks),
    minImpressions: num_(map['Minimum Impressions Before Alert'], DEFAULTS.minImpressions),
    enablePageAlerts: yesNo_(map['Enable Page Level Alerts'], DEFAULTS.enablePageAlerts),
    enableQueryAlerts: yesNo_(map['Enable Query Level Alerts'], DEFAULTS.enableQueryAlerts)
  };
}

// ============================ DATE RANGES ============================

/**
 * Computes the current and previous comparison windows, excluding the most
 * recent `dataDelayDays` days (GSC data lags). Returns YYYY-MM-DD strings.
 */
function getDateRanges(settings) {
  var tz = Session.getScriptTimeZone();
  var delay = settings.dataDelayDays;
  var win = settings.comparisonWindowDays;
  var today = new Date();

  var currentEnd = addDays_(today, -delay);
  var currentStart = addDays_(currentEnd, -(win - 1));
  var previousEnd = addDays_(currentStart, -1);
  var previousStart = addDays_(previousEnd, -(win - 1));

  return {
    currentStart: fmtDate_(currentStart, tz),
    currentEnd: fmtDate_(currentEnd, tz),
    previousStart: fmtDate_(previousStart, tz),
    previousEnd: fmtDate_(previousEnd, tz)
  };
}

// ============================ GSC API ============================

/**
 * Low-level GSC Search Analytics query. Throws descriptive errors for the
 * common failure modes (403 unauthorized, 404 not found, other API errors).
 */
function queryGsc_(siteUrl, payload) {
  var url = 'https://www.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(siteUrl) + '/searchAnalytics/query';
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  var body = resp.getContentText();

  if (code === 403) {
    throw new Error('Unauthorized / no access to property (403): ' + siteUrl);
  }
  if (code === 404) {
    throw new Error('Property not found (404). Check the GSC Property URL: ' + siteUrl);
  }
  if (code !== 200) {
    throw new Error('GSC API error ' + code + ': ' + body);
  }
  var data = JSON.parse(body);
  return data.rows || [];
}

/**
 * Pulls aggregate summary metrics for a property/date range.
 * Returns { clicks, impressions, ctr (%), position, hasData }.
 */
function getGscSummaryData(siteUrl, startDate, endDate) {
  if (!siteUrl) throw new Error('Missing GSC Property URL');
  var rows = queryGsc_(siteUrl, {
    startDate: startDate,
    endDate: endDate,
    dimensions: [],
    rowLimit: 1
  });
  if (!rows || rows.length === 0) {
    return { clicks: 0, impressions: 0, ctr: 0, position: 0, hasData: false };
  }
  var r = rows[0];
  return {
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: (r.ctr || 0) * 100,       // GSC returns a 0..1 ratio; convert to %.
    position: r.position || 0,
    hasData: true
  };
}

/**
 * Pulls page-level metrics (top pages by clicks) for a property/date range.
 * Returns an array of { url, clicks, impressions, ctr (%), position }.
 */
function getGscPageData(siteUrl, startDate, endDate) {
  if (!siteUrl) throw new Error('Missing GSC Property URL');
  var rows = queryGsc_(siteUrl, {
    startDate: startDate,
    endDate: endDate,
    dimensions: ['page'],
    rowLimit: 100
  });
  return rows.map(function (r) {
    return {
      url: r.keys[0],
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: (r.ctr || 0) * 100,
      position: r.position || 0
    };
  });
}

// ============================ COMPARISON / RULES ============================

/**
 * Calculates percentage changes and the raw position change.
 * Note: a POSITIVE positionChange means the average position number went up,
 * i.e. the ranking got WORSE.
 */
function compareMetrics(current, previous) {
  return {
    current: current,
    previous: previous,
    clickChange: pctChange_(current.clicks, previous.clicks),
    impressionChange: pctChange_(current.impressions, previous.impressions),
    ctrChange: pctChange_(current.ctr, previous.ctr),
    positionChange: round_(current.position - previous.position, 2)
  };
}

/**
 * Evaluates all alert rules for a project. Returns { send, alerts[] } where
 * alerts is a list of human-readable trigger strings.
 */
function shouldSendAlert(project, comparison, settings) {
  var alerts = [];
  var c = comparison;
  var prev = c.previous;

  // Noise guard: skip low-signal properties entirely.
  if (prev.clicks < settings.minClicks && prev.impressions < settings.minImpressions) {
    return { send: false, alerts: [], reason: 'Below minimum clicks and impressions' };
  }

  // Clicks dropped by threshold (only if previous clicks meet the minimum).
  if (prev.clicks >= settings.minClicks && c.clickChange !== null &&
      c.clickChange <= -project.clickDropThreshold) {
    alerts.push('Clicks down ' + Math.abs(c.clickChange) + '%');
  }

  // Impressions dropped by threshold (only if previous impressions meet min).
  if (prev.impressions >= settings.minImpressions && c.impressionChange !== null &&
      c.impressionChange <= -project.impressionDropThreshold) {
    alerts.push('Impressions down ' + Math.abs(c.impressionChange) + '%');
  }

  // CTR dropped by threshold.
  if (c.ctrChange !== null && c.ctrChange <= -project.ctrDropThreshold) {
    alerts.push('CTR down ' + Math.abs(c.ctrChange) + '%');
  }

  // Average position worsened (increased) beyond threshold.
  if (project.positionThreshold > 0 && c.positionChange >= project.positionThreshold) {
    alerts.push('Average position worsened by ' + round_(c.positionChange, 1));
  }

  // Opportunity: impressions up >=10% but clicks flat or down.
  if (prev.impressions >= settings.minImpressions &&
      c.impressionChange !== null && c.impressionChange >= 10 &&
      c.clickChange !== null && c.clickChange <= 0) {
    alerts.push('Opportunity: impressions up ' + c.impressionChange +
      '% but clicks flat/down (' + c.clickChange + '%)');
  }

  return { send: alerts.length > 0, alerts: alerts };
}

/**
 * Finds pages that lost more than the page threshold (default 25%) of clicks
 * or impressions. Returns up to 5 worst decliners sorted by biggest click drop.
 */
function getDecliningPages(project, ranges) {
  var curPages = getGscPageData(project.siteUrl, ranges.currentStart, ranges.currentEnd);
  var prevPages = getGscPageData(project.siteUrl, ranges.previousStart, ranges.previousEnd);

  var prevMap = {};
  prevPages.forEach(function (p) { prevMap[p.url] = p; });

  var declines = [];
  curPages.forEach(function (cur) {
    var prev = prevMap[cur.url];
    if (!prev) return;
    if (prev.clicks < DEFAULTS.pageMinPrevClicks) return; // ignore tiny pages
    var clickChange = pctChange_(cur.clicks, prev.clicks);
    var impChange = pctChange_(cur.impressions, prev.impressions);
    var t = -DEFAULTS.pageDropThreshold;
    if ((clickChange !== null && clickChange <= t) ||
        (impChange !== null && impChange <= t)) {
      declines.push({
        url: cur.url,
        clickChange: clickChange === null ? 0 : clickChange,
        impressionChange: impChange === null ? 0 : impChange,
        prevClicks: prev.clicks
      });
    }
  });

  declines.sort(function (a, b) { return a.clickChange - b.clickChange; });
  return declines.slice(0, 5);
}

// ============================ SLACK ============================

/**
 * Builds the Slack alert message text (Slack mrkdwn).
 */
function buildSlackMessage(project, ranges, alerts, comparison, pageDeclines) {
  var c = comparison.current;
  var p = comparison.previous;
  var m = '';

  m += ':rotating_light: *GSC SEO Alert: ' + project.name + '*\n\n';
  m += '*Period:*\n' + ranges.currentStart + ' to ' + ranges.currentEnd + '\n';
  m += '*Compared with:*\n' + ranges.previousStart + ' to ' + ranges.previousEnd + '\n\n';

  m += '*Triggered alerts:*\n';
  alerts.forEach(function (a) { m += '• ' + a + '\n'; });

  m += '\n*Current period:*\n';
  m += '• Clicks: ' + fmtNum_(c.clicks) + '\n';
  m += '• Impressions: ' + fmtNum_(c.impressions) + '\n';
  m += '• CTR: ' + round_(c.ctr, 2) + '%\n';
  m += '• Avg position: ' + round_(c.position, 1) + '\n';

  m += '\n*Previous period:*\n';
  m += '• Clicks: ' + fmtNum_(p.clicks) + '\n';
  m += '• Impressions: ' + fmtNum_(p.impressions) + '\n';
  m += '• CTR: ' + round_(p.ctr, 2) + '%\n';
  m += '• Avg position: ' + round_(p.position, 1) + '\n';

  if (pageDeclines && pageDeclines.length) {
    m += '\n*Top declining pages:*\n';
    pageDeclines.slice(0, 5).forEach(function (pg, i) {
      m += (i + 1) + '. ' + pg.url +
        ', clicks down ' + Math.abs(pg.clickChange) + '%' +
        ', impressions down ' + Math.abs(pg.impressionChange) + '%\n';
    });
  }

  m += '\n*Suggested next checks:*\n';
  m += '• Review affected landing pages\n';
  m += '• Check top queries with lost impressions or position\n';
  m += '• Check recent site edits, indexing issues, or content changes\n';
  m += '• Check if seasonality or tracking changes may explain the movement\n';

  return m;
}

/**
 * Posts a message to a Slack Incoming Webhook. Throws on missing webhook or a
 * non-200 response.
 */
function sendSlackAlert(webhookUrl, message) {
  if (!webhookUrl) throw new Error('Missing Slack webhook URL');
  var resp = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: message }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error('Slack webhook failed (' + code + '): ' + resp.getContentText());
  }
  return true;
}

// ============================ LOGGING / DEDUPE ============================

/**
 * Appends a row to the Alert Log sheet. Accepts a flat alertData object; any
 * missing field is written blank. slackSent should be 'Yes' or 'No'.
 */
function logAlert(alertData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_LOG) || ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);
  if (sheet.getLastRow() < 1) sheet.appendRow(LOG_HEADERS);

  sheet.appendRow([
    new Date(),
    alertData.projectName || '',
    alertData.alertType || '',
    alertData.currentPeriod || '',
    alertData.previousPeriod || '',
    valOrBlank_(alertData.currentClicks),
    valOrBlank_(alertData.previousClicks),
    valOrBlank_(alertData.clickChange),
    valOrBlank_(alertData.currentImpressions),
    valOrBlank_(alertData.previousImpressions),
    valOrBlank_(alertData.impressionChange),
    valOrBlank_(alertData.currentCtr),
    valOrBlank_(alertData.previousCtr),
    valOrBlank_(alertData.ctrChange),
    valOrBlank_(alertData.currentPosition),
    valOrBlank_(alertData.previousPosition),
    valOrBlank_(alertData.positionChange),
    alertData.slackSent || 'No',
    alertData.notes || ''
  ]);
}

/**
 * Returns true if a Slack alert was already SENT for this project + date range.
 * Prevents duplicate alerts for the same project and same comparison window.
 * (alertType is accepted for signature completeness; dedupe is by project +
 * date range, which is what "same project and same date range" requires.)
 */
function alreadyAlerted(projectName, dateRange, alertType) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_LOG);
  if (!sheet || sheet.getLastRow() < 2) return false;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[LOG_COL_PROJECT]) === projectName &&
        String(row[LOG_COL_CURRENT_PERIOD]) === dateRange &&
        String(row[LOG_COL_SLACK_SENT]) === 'Yes') {
      return true;
    }
  }
  return false;
}

// ============================ MAIN ============================

/**
 * Main entry point. Checks every active project and sends Slack alerts.
 * Intended to be run daily via a time-based trigger (see createDailyTrigger).
 */
function runGscSlackAlerts() {
  var settings, projects, ranges;
  try {
    settings = getSettings();
    projects = getProjects();
    ranges = getDateRanges(settings);
  } catch (e) {
    Logger.log('Fatal setup error: ' + e.message);
    try {
      logAlert({ projectName: 'SYSTEM', alertType: 'Error', slackSent: 'No',
        notes: 'Setup error: ' + e.message });
    } catch (ignored) {}
    return;
  }

  var currentPeriod = ranges.currentStart + ' to ' + ranges.currentEnd;
  var previousPeriod = ranges.previousStart + ' to ' + ranges.previousEnd;

  projects.forEach(function (project) {
    try {
      if (!project.siteUrl) throw new Error('Missing GSC Property URL');

      // --- Summary metrics for both periods ---
      var cur = getGscSummaryData(project.siteUrl, ranges.currentStart, ranges.currentEnd);
      var prev = getGscSummaryData(project.siteUrl, ranges.previousStart, ranges.previousEnd);

      if (!cur.hasData && !prev.hasData) {
        logAlert({
          projectName: project.name, alertType: 'No Data',
          currentPeriod: currentPeriod, previousPeriod: previousPeriod,
          slackSent: 'No', notes: 'No GSC data returned for either period'
        });
        return;
      }

      var comparison = compareMetrics(cur, prev);
      var decision = shouldSendAlert(project, comparison, settings);

      // --- Page-level checks (if enabled + requested by Check Type) ---
      var pageDeclines = [];
      var wantsPages = project.checkType.indexOf('page') !== -1 ||
                       project.checkType === 'both' ||
                       project.checkType === 'summary+pages' ||
                       project.checkType === '';
      if (settings.enablePageAlerts && wantsPages) {
        try {
          pageDeclines = getDecliningPages(project, ranges);
        } catch (pageErr) {
          Logger.log('Page check failed for ' + project.name + ': ' + pageErr.message);
        }
      }

      var triggers = decision.alerts.slice();
      if (pageDeclines.length) {
        triggers.push(pageDeclines.length + ' key page(s) dropped significantly');
      }

      // Nothing crossed a threshold -> no alert.
      if (triggers.length === 0) {
        return;
      }

      // Dedupe: don't re-send for the same project + comparison window.
      if (alreadyAlerted(project.name, currentPeriod, 'SEO Alert')) {
        return;
      }

      // --- Build + send Slack message ---
      var message = buildSlackMessage(project, ranges, triggers, comparison, pageDeclines);
      var slackSent = 'No';
      var note = triggers.join('; ');

      try {
        sendSlackAlert(project.webhookUrl, message);
        slackSent = 'Yes';
      } catch (slackErr) {
        note = 'Slack send failed: ' + slackErr.message + ' | Triggers: ' + note;
        Logger.log(note);
      }

      logAlert({
        projectName: project.name,
        alertType: 'SEO Alert',
        currentPeriod: currentPeriod,
        previousPeriod: previousPeriod,
        currentClicks: cur.clicks, previousClicks: prev.clicks,
        clickChange: comparison.clickChange,
        currentImpressions: cur.impressions, previousImpressions: prev.impressions,
        impressionChange: comparison.impressionChange,
        currentCtr: round_(cur.ctr, 2), previousCtr: round_(prev.ctr, 2),
        ctrChange: comparison.ctrChange,
        currentPosition: round_(cur.position, 1), previousPosition: round_(prev.position, 1),
        positionChange: comparison.positionChange,
        slackSent: slackSent,
        notes: note
      });

    } catch (err) {
      // Any per-project error is logged with Slack Sent = No and does not
      // stop the other projects from being processed.
      Logger.log('Error for project ' + project.name + ': ' + err.message);
      logAlert({
        projectName: project.name,
        alertType: 'Error',
        currentPeriod: currentPeriod,
        previousPeriod: previousPeriod,
        slackSent: 'No',
        notes: err.message
      });
    }
  });
}

// ============================ TRIGGER ============================

/**
 * Creates (or replaces) a daily time-based trigger that runs
 * runGscSlackAlerts() around 9am in the script's timezone.
 */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runGscSlackAlerts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runGscSlackAlerts')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
  Logger.log('Daily trigger created (runs ~9am script timezone).');
}

// ============================ HELPERS ============================

/** Percentage change from prev -> cur, rounded to 1dp. Null if prev is 0. */
function pctChange_(cur, prev) {
  if (!prev || prev === 0) return null;
  return round_(((cur - prev) / prev) * 100, 1);
}

/** Rounds a number to n decimal places. */
function round_(v, n) {
  var f = Math.pow(10, n || 0);
  return Math.round((Number(v) || 0) * f) / f;
}

/** Parses a value as a number, returning def when blank/NaN. */
function num_(v, def) {
  if (v === '' || v === null || v === undefined) return def;
  var n = parseFloat(v);
  return isNaN(n) ? def : n;
}

/** Interprets a yes/no cell, returning def when blank. */
function yesNo_(v, def) {
  if (v === undefined || v === '' || v === null) return def;
  if (v === true) return true;
  return String(v).toLowerCase().trim() === 'yes';
}

/** Adds (or subtracts) whole days to a date. */
function addDays_(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Formats a date as YYYY-MM-DD in the given timezone. */
function fmtDate_(date, tz) {
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd');
}

/** Formats an integer-ish number with thousands separators. */
function fmtNum_(v) {
  return Math.round(Number(v) || 0).toLocaleString('en-US');
}

/** Returns the value, or '' when null/undefined (keeps 0 as 0). */
function valOrBlank_(v) {
  return (v === null || v === undefined) ? '' : v;
}
