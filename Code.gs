/* ContentBridge backend - COMPLETE Code.gs (replaces everything in your Apps Script project)
 *
 * SETUP (one time):
 *  1. Apps Script editor > Code.gs: delete old code, paste this whole file, Save.
 *  2. Project Settings > tick "Show appsscript.json" and REMOVE any "oauthScopes" block
 *     (Apps Script then asks for the right permissions automatically).
 *  3. Select function `authorize` at the top > Run > Review permissions > Allow.
 *  4. Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy.
 *     Execute as: Me   |   Who has access: Anyone      (the /exec URL stays the same)
 *
 * NOTE: this starts with fresh data and the starting passwords:
 *   developer / dev123   and   mdsir / md123
 */

const FOLDER_ID = '1pIAQ2p5z9H3sIhyTsivqhP1FaXkEYohF';   // shared Drive folder for videos
const USERS = {
  developer: { role: 'dev', name: 'Meghla',         pass: 'dev123' },
  mdsir:     { role: 'md',  name: 'MD Jahir Uddin', pass: 'md123'  }
};
const DATA_FILE = 'contentbridge-data.json';
const P = PropertiesService.getScriptProperties();

/* ---------- entry points ---------- */
function doGet() { return out({ ok: true, msg: 'ContentBridge backend is running' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'login':        return out(login(d));
      case 'load':         return out(guard(d, load));
      case 'save':         return out(guard(d, save));
      case 'sendMessage':  return out(guard(d, sendMessage));
      case 'profile':      return out(guard(d, profile));
      case 'startUpload':  return out(guard(d, startUpload));
      case 'finishUpload': return out(guard(d, finishUpload));
      default:             return out({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return out({ ok: false, error: String(err) });   // always JSON, never an HTML error page
  } finally { try { lock.releaseLock(); } catch (x) {} }
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ---------- storage ---------- */
function dataFile() {
  let id = P.getProperty('dataFileId');
  if (id) { try { return DriveApp.getFileById(id); } catch (e) {} }
  const f = DriveApp.createFile(DATA_FILE, JSON.stringify({ tasks: [], notices: [], msgs: [], people: {}, rev: 1 }), 'application/json');
  P.setProperty('dataFileId', f.getId());
  return f;
}
function readState() { const s = JSON.parse(dataFile().getBlob().getDataAsString() || '{}'); return Object.assign({ tasks: [], notices: [], msgs: [], people: {}, rev: 1 }, s); }
function writeState(s) { s.rev = (s.rev || 0) + 1; dataFile().setContent(JSON.stringify(s)); return s.rev; }

function hash(pw) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'cb|' + pw)); }
function getAuth() { return JSON.parse(P.getProperty('auth') || '{}'); }          // { username: {hash} }
function setAuth(a) { P.setProperty('auth', JSON.stringify(a)); }
function getTokens() { return JSON.parse(P.getProperty('tokens') || '{}'); }       // { token: username }

/* ---------- auth ---------- */
function login(d) {
  const un = String(d.username || '').trim().toLowerCase(), u = USERS[un];
  if (!u) return { ok: false };
  const auth = getAuth(), stored = auth[un] && auth[un].hash;
  const good = stored ? stored === hash(d.password) : d.password === u.pass;
  if (!good) return { ok: false };
  const token = Utilities.getUuid() + Utilities.getUuid();
  const t = getTokens(); const keys = Object.keys(t); if (keys.length > 40) delete t[keys[0]];
  t[token] = un; P.setProperty('tokens', JSON.stringify(t));
  const s = readState(), pe = s.people[u.role] || {};
  return { ok: true, role: u.role, name: pe.name || u.name, photo: pe.photo || '', weak: !stored, token: token, data: s };
}

function guard(d, fn) {
  const un = getTokens()[d.token];
  if (!un) return { ok: false, error: 'auth' };
  return fn(d, un, USERS[un]);
}

/* ---------- data actions ---------- */
function load(d) {
  const s = readState();
  if (d.since && d.since === s.rev) return { ok: true, same: true, rev: s.rev };
  return { ok: true, data: s, rev: s.rev };
}

function save(d) {
  const s = readState();
  if (d.data && Array.isArray(d.data.tasks)) {
    try { s.tasks = syncCalendar(d.data.tasks); } catch (e) { s.tasks = d.data.tasks; }   // calendar failure must never block saving
  }
  if (d.data && Array.isArray(d.data.notices)) s.notices = d.data.notices.slice(0, 60);
  return { ok: true, rev: writeState(s) };
}

function sendMessage(d) {
  const s = readState();
  s.msgs.push(d.msg); s.msgs = s.msgs.slice(-500);
  return { ok: true, rev: writeState(s) };
}

function profile(d, un, u) {
  const s = readState();
  s.people[u.role] = { name: String(d.name || u.name).slice(0, 40), photo: d.photo || '' };
  if (d.newPassword) {
    const auth = getAuth(), stored = auth[un] && auth[un].hash;
    const okOld = stored ? stored === hash(d.oldPassword) : d.oldPassword === u.pass;
    if (!okOld) return { ok: false, error: 'Current password is wrong' };
    auth[un] = { hash: hash(d.newPassword) }; setAuth(auth);
  }
  return { ok: true, rev: writeState(s) };
}

/* ---------- Drive upload (resumable, browser sends the file straight to Drive) ---------- */
function startUpload(d) {
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': d.mime || 'video/mp4',
        'X-Upload-Content-Length': String(d.size),
        Origin: d.origin
      },
      payload: JSON.stringify({ name: d.name, parents: [FOLDER_ID] }),
      muteHttpExceptions: true
    });
  if (res.getResponseCode() !== 200)
    return { ok: false, error: 'Drive ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150) };
  const h = res.getAllHeaders();
  return { ok: true, uploadUrl: h['Location'] || h['location'] };
}

function finishUpload(d) {
  let file = null;
  if (d.id) { try { file = DriveApp.getFileById(d.id); } catch (e) {} }
  if (!file) { const it = DriveApp.getFolderById(FOLDER_ID).getFilesByName(d.name); if (it.hasNext()) file = it.next(); }
  if (!file) return { ok: false, error: 'video not found in Drive folder' };
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { ok: true, link: file.getUrl() };
}

/* ---------- Google Calendar (adds one all-day event per task with a due date) ---------- */
function syncCalendar(tasks) {
  const cal = CalendarApp.getDefaultCalendar();
  tasks.forEach(t => {
    if (!t.due || t.eventId) return;
    const ev = cal.createAllDayEvent('Video due: ' + t.topic, new Date(t.due + 'T00:00:00'),
      { description: (t.qty || 1) + ' video(s)\n\n' + (t.notes || '') });
    t.eventId = ev.getId();
  });
  return tasks;
}

/* Run this ONCE from the editor so Google asks for Drive + Calendar + external request permission */
function authorize() {
  DriveApp.getFolderById(FOLDER_ID).getName();
  CalendarApp.getDefaultCalendar().getName();
  UrlFetchApp.fetch('https://www.googleapis.com/discovery/v1/apis', { muteHttpExceptions: true });
  dataFile();
  Logger.log('All permissions OK');
}
