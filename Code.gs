/**
 * CardCapture — 명함 캡처 업로드 엔드포인트 (G0)
 * Kairen PRJ-000005 / TSK-000106
 *
 * 배포: Google Apps Script 웹 앱 (실행 계정: 나, 액세스: 모든 사용자)
 *
 * Script Properties (프로젝트 설정 → 스크립트 속성):
 *   INBOX_FOLDER_ID  필수. vault의 00_Inbox/BusinessCards 폴더의 Drive 폴더 ID
 *   TOKENS           필수. JSON 문자열: {"긴랜덤토큰1":"강규","긴랜덤토큰2":"홍길동"}
 *   DAILY_LIMIT      선택. 토큰당 하루 업로드 상한 (기본 100)
 *   OWNER_NAMES      선택. 쉼표 구분 이름 목록 (예: "강규") — 이 이름의 토큰은 모든 캡처의 브리핑을 봄. 그 외는 자기 캡처만.
 *
 * 클라이언트 계약 (webapp/index.html):
 *   POST body (text/plain, JSON): {
 *     k: 토큰, captureId: "yyyyMMdd-HHmmss-xxxx", capturedAt: ISO문자열,
 *     event: 행사명(선택), note: 한줄메모(선택),
 *     images: [{name:"front.jpg"|"back.jpg", mime:"image/jpeg", dataB64:"..."}]
 *   }
 *   GET ?action=ping           → 상태 확인
 *   GET ?action=whoami&k=토큰  → 토큰 유효성/이름 확인
 */

var CONF = PropertiesService.getScriptProperties();

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'ping') {
    return json_({ ok: true, service: 'card-capture', time: new Date().toISOString() });
  }
  if (action === 'whoami') {
    var name = capturerFor_(e.parameter.k);
    return json_(name ? { ok: true, name: name } : { ok: false, error: 'invalid_token' });
  }
  if (action === 'list') {
    return listCaptures_(e.parameter.k);
  }
  return json_({ ok: false, error: 'unknown_action' });
}

/* 브리핑 목록: 토큰 소유자의 캡처(OWNER_NAMES에 있으면 전체)를 최신순으로 반환 */
function listCaptures_(token) {
  var name = capturerFor_(token);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  var owners = String(CONF.getProperty('OWNER_NAMES') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  var seeAll = owners.indexOf(name) >= 0;
  var inboxId = CONF.getProperty('INBOX_FOLDER_ID');
  if (!inboxId) return json_({ ok: false, error: 'not_configured' });

  var folders = DriveApp.getFolderById(inboxId).getFolders();
  var entries = [];
  while (folders.hasNext()) entries.push(folders.next());
  entries.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; }); /* captureId 최신순 */

  var items = [];
  for (var i = 0; i < entries.length && items.length < 30; i++) {
    var folder = entries[i];
    var meta = readJsonFile_(folder);
    if (!meta) continue;
    if (!seeAll && String(meta.capturer || '') !== name) continue;
    var item = {
      captureId: meta.captureId || folder.getName(),
      capturer: meta.capturer || '',
      capturedAt: meta.capturedAt || '',
      event: meta.event || '',
      status: meta.status || 'received',
      person: meta.person || '',
      personAction: meta.personAction || ''
    };
    var brief = readTextFile_(folder, 'brief.md');
    if (brief) item.brief = brief.slice(0, 6000);
    items.push(item);
  }
  return json_({ ok: true, name: name, seeAll: seeAll, items: items });
}

function readTextFile_(folder, fname) {
  var it = folder.getFilesByName(fname);
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

/* capture.json을 읽되, Drive 동기화가 만든 "capture (1).json" 변형도 최신 수정본으로 허용 */
function readJsonFile_(folder) {
  var txt = readTextFile_(folder, 'capture.json');
  if (txt === null) {
    var files = folder.getFiles();
    var best = null;
    while (files.hasNext()) {
      var f = files.next();
      var n = f.getName();
      if (n.indexOf('capture') === 0 && n.slice(-5) === '.json') {
        if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
      }
    }
    if (!best) return null;
    txt = best.getBlob().getDataAsString('UTF-8');
  }
  try { return JSON.parse(txt); } catch (err) { return null; }
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var name = capturerFor_(req.k);
    if (!name) return json_({ ok: false, error: 'invalid_token' });
    if (!withinDailyLimit_(req.k)) return json_({ ok: false, error: 'daily_limit' });

    var captureId = sanitizeId_(req.captureId) || newId_();
    var images = (req.images || []).slice(0, 4);
    if (!images.length) return json_({ ok: false, error: 'no_images' });

    var inboxId = CONF.getProperty('INBOX_FOLDER_ID');
    if (!inboxId) return json_({ ok: false, error: 'not_configured' });
    var inbox = DriveApp.getFolderById(inboxId);

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    var folder;
    try {
      var it = inbox.getFoldersByName(captureId);
      folder = it.hasNext() ? it.next() : inbox.createFolder(captureId);
    } finally {
      lock.releaseLock();
    }

    var saved = [];
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var fname = sanitizeName_(img.name) || ('image' + i + '.jpg');
      var bytes;
      try {
        bytes = Utilities.base64Decode(img.dataB64);
      } catch (decodeErr) {
        return json_({ ok: false, error: 'bad_image_data', file: fname });
      }
      if (bytes.length > 8 * 1024 * 1024) return json_({ ok: false, error: 'image_too_large', file: fname });
      var blob = Utilities.newBlob(bytes, img.mime || 'image/jpeg', fname);
      upsertFile_(folder, fname, blob);
      saved.push(fname);
    }

    var meta = {
      captureId: captureId,
      capturer: name,
      capturedAt: String(req.capturedAt || ''),
      receivedAt: new Date().toISOString(),
      event: String(req.event || '').slice(0, 200),
      note: String(req.note || '').slice(0, 2000),
      files: saved,
      status: 'received'
    };
    upsertFile_(folder, 'capture.json',
      Utilities.newBlob(JSON.stringify(meta, null, 2), 'application/json', 'capture.json'));

    return json_({ ok: true, captureId: captureId, files: saved });
  } catch (err) {
    return json_({ ok: false, error: 'server_error', detail: String(err) });
  }
}

function capturerFor_(token) {
  if (!token) return null;
  try {
    var tokens = JSON.parse(CONF.getProperty('TOKENS') || '{}');
    var name = tokens[String(token)];
    return name ? String(name) : null;
  } catch (err) {
    return null;
  }
}

function withinDailyLimit_(token) {
  var limit = parseInt(CONF.getProperty('DAILY_LIMIT') || '100', 10);
  var cache = CacheService.getScriptCache();
  var key = 'cnt_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd') + '_' + token;
  var n = parseInt(cache.get(key) || '0', 10) + 1;
  cache.put(key, String(n), 24 * 60 * 60);
  return n <= limit;
}

function sanitizeId_(id) {
  if (!id) return null;
  var s = String(id);
  return /^[A-Za-z0-9_-]{4,64}$/.test(s) ? s : null;
}

function sanitizeName_(name) {
  if (!name) return null;
  var s = String(name).replace(/[^A-Za-z0-9._-]/g, '');
  if (!s || s.indexOf('.') === 0) return null;
  return s.slice(0, 64);
}

function upsertFile_(folder, fname, blob) {
  var it = folder.getFilesByName(fname);
  while (it.hasNext()) it.next().setTrashed(true);
  folder.createFile(blob);
}

function newId_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd-HHmmss') + '-' +
    Utilities.getUuid().slice(0, 4);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
