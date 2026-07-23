/**
 * CardCapture — 명함 캡처 업로드 엔드포인트
 * Kairen PRJ-000005 / TSK-000106 (G0) · PRJ-000006 / TSK-000154 (search·doc) · TSK-000155 (notify) · TSK-000148 (correction)
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
 *   GET ?action=list&k=토큰    → 브리핑 목록 (토큰 scope, OWNER_NAMES는 전체)
 *   GET ?action=persondoc&k=토큰&captureId=ID → Person .md 전문 (OWNER_NAMES 한정)
 *   GET ?action=search&k=토큰&q=검색어        → Person 검색 (OWNER_NAMES 한정)
 *   GET ?action=doc&k=토큰&id=파일ID          → 검색 결과 Person .md 전문 (OWNER_NAMES 한정, Person 폴더 내부만)
 *   GET ?action=notify&k=토큰&captureId=ID    → 처리 완료 알림 메일 발송 (소유자 메일로, 캡처 6시간 dedup)
 *   POST {action:'correction', k, captureId, text} → 수정 요청 저장 + 재처리 대기 전환
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
  if (action === 'persondoc') {
    return personDoc_(e.parameter.k, e.parameter.captureId);
  }
  if (action === 'search') {
    return searchPersons_(e.parameter.k, e.parameter.q);
  }
  if (action === 'doc') {
    return personDocById_(e.parameter.k, e.parameter.id);
  }
  if (action === 'notify') {
    return notifyProcessed_(e.parameter.k, e.parameter.captureId);
  }
  return json_({ ok: false, error: 'unknown_action' });
}

/* OWNER_NAMES 판정 */
function isOwner_(name) {
  var owners = String(CONF.getProperty('OWNER_NAMES') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  return owners.indexOf(name) >= 0;
}

/* vault Person 폴더 탐색: inbox → 00_Inbox → Kairen → 02_Kairen_OS/30_Instance/Person */
function personFolder_() {
  var inbox = DriveApp.getFolderById(CONF.getProperty('INBOX_FOLDER_ID'));
  var p1 = inbox.getParents(); if (!p1.hasNext()) return null;
  var p2 = p1.next().getParents(); if (!p2.hasNext()) return null;
  var kairen = p2.next();
  return subFolder_(subFolder_(subFolder_(kairen, '02_Kairen_OS'), '30_Instance'), 'Person');
}

/* 인맥 검색 — OWNER_NAMES 토큰만 (Person 전문에 Private 섹션이 있을 수 있음).
   이름(title) 우선, 부족하면 본문(fullText)까지. 최대 10건. */
function searchPersons_(token, q) {
  var name = capturerFor_(token);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  if (!isOwner_(name)) return json_({ ok: false, error: 'owner_only' });
  var query = String(q || '').replace(/['"\\]/g, ' ').trim().slice(0, 80);
  if (!query) return json_({ ok: false, error: 'empty_query' });
  var folder = personFolder_();
  if (!folder) return json_({ ok: false, error: 'person_folder_not_found' });
  var seen = {};
  var items = [];
  var collect = function (files, via) {
    while (files.hasNext() && items.length < 10) {
      var f = files.next();
      if (seen[f.getId()]) continue;
      seen[f.getId()] = true;
      if (f.getName().slice(-3) !== '.md') continue;
      items.push({ id: f.getId(), title: f.getName().replace(/\.md$/, ''), via: via });
    }
  };
  collect(folder.searchFiles("title contains '" + query + "'"), 'title');
  if (items.length < 10) collect(folder.searchFiles("fullText contains '" + query + "'"), 'content');
  return json_({ ok: true, q: query, items: items });
}

/* Person 문서 조회(검색 결과 파일 ID) — Person 폴더 직속 파일만, OWNER_NAMES 한정 */
function personDocById_(token, fileId) {
  var name = capturerFor_(token);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  if (!isOwner_(name)) return json_({ ok: false, error: 'owner_only' });
  var id = String(fileId || '');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id)) return json_({ ok: false, error: 'bad_id' });
  var folder = personFolder_();
  if (!folder) return json_({ ok: false, error: 'person_folder_not_found' });
  var f;
  try { f = DriveApp.getFileById(id); } catch (err) { return json_({ ok: false, error: 'not_found' }); }
  var inPerson = false;
  var parents = f.getParents();
  while (parents.hasNext()) { if (parents.next().getId() === folder.getId()) { inPerson = true; break; } }
  if (!inPerson) return json_({ ok: false, error: 'outside_person_folder' });
  return json_({ ok: true, person: f.getName().replace(/\.md$/, ''), markdown: f.getBlob().getDataAsString('UTF-8').slice(0, 60000) });
}

/* 처리 완료 알림 — 유효 토큰 필수(자기 캡처 또는 owner), 소유자 메일로 최소 정보만 발송.
   같은 captureId는 6시간 dedup. 실패해도 처리 상태에는 영향 없음(호출측 계약). */
function notifyProcessed_(token, captureId) {
  var name = capturerFor_(token);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  var cid = sanitizeId_(captureId);
  if (!cid) return json_({ ok: false, error: 'bad_capture_id' });
  var inbox = DriveApp.getFolderById(CONF.getProperty('INBOX_FOLDER_ID'));
  var it = inbox.getFoldersByName(cid);
  if (!it.hasNext()) return json_({ ok: false, error: 'not_found' });
  var meta = readJsonFile_(it.next());
  if (!meta || meta.status !== 'processed') return json_({ ok: false, error: 'not_processed' });
  if (meta.capturer !== name && !isOwner_(name)) return json_({ ok: false, error: 'not_your_capture' });
  var cache = CacheService.getScriptCache();
  var key = 'ntf_' + cid;
  if (cache.get(key)) return json_({ ok: true, deduped: true });
  cache.put(key, '1', 6 * 60 * 60);
  var to = Session.getEffectiveUser().getEmail();
  if (!to) return json_({ ok: false, error: 'no_owner_email' });
  MailApp.sendEmail({
    to: to,
    subject: '[명함] 처리 완료: ' + (meta.person || cid),
    body: '명함 처리가 끝났어요.\n\n' +
      '대상: ' + (meta.person || '(미상)') + (meta.personAction ? ' (' + meta.personAction + ')' : '') + '\n' +
      '촬영: ' + (meta.capturer || '') + (meta.event ? ' / ' + meta.event : '') + '\n\n' +
      '브리핑 보기: https://guecom.github.io/card-capture/\n\n' +
      '- Kairen Card Capture (자동 발송, 회신 불필요)'
  });
  return json_({ ok: true, notified: to.replace(/^(.).*(@.*)$/, '$1***$2') });
}

/* 수정 요청 저장 — 캡처를 찍은 본인 또는 owner. correction-*.json 기록 후 재처리 대기(received) 전환.
   처리 파이프라인이 correction을 사용자 정정 출처로 반영한다(CardCapture_Processing 규칙 2-1). */
function correction_(req) {
  var name = capturerFor_(req.k);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  var cid = sanitizeId_(req.captureId);
  if (!cid) return json_({ ok: false, error: 'bad_capture_id' });
  var text = String(req.text || '').trim().slice(0, 2000);
  if (!text) return json_({ ok: false, error: 'empty_text' });
  var inbox = DriveApp.getFolderById(CONF.getProperty('INBOX_FOLDER_ID'));
  var it = inbox.getFoldersByName(cid);
  if (!it.hasNext()) return json_({ ok: false, error: 'not_found' });
  var folder = it.next();
  var meta = readJsonFile_(folder);
  if (!meta) return json_({ ok: false, error: 'no_capture_json' });
  if (meta.capturer !== name && !isOwner_(name)) return json_({ ok: false, error: 'not_your_capture' });
  var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd-HHmmss');
  var correction = { captureId: cid, capturer: name, text: text, requestedAt: new Date().toISOString() };
  folder.createFile(Utilities.newBlob(JSON.stringify(correction, null, 2), 'application/json', 'correction-' + stamp + '.json'));
  meta.status = 'received';
  meta.receivedAt = new Date().toISOString();
  meta.correctionRequested = true;
  upsertFile_(folder, 'capture.json',
    Utilities.newBlob(JSON.stringify(meta, null, 2), 'application/json', 'capture.json'));
  return json_({ ok: true, captureId: cid });
}

/* Person Instance .md 전문 조회 — OWNER_NAMES 토큰만 (Private 섹션 포함이므로) */
function personDoc_(token, captureId) {
  var name = capturerFor_(token);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  var owners = String(CONF.getProperty('OWNER_NAMES') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  if (owners.indexOf(name) < 0) return json_({ ok: false, error: 'owner_only' });
  var cid = sanitizeId_(captureId);
  if (!cid) return json_({ ok: false, error: 'bad_capture_id' });

  var inbox = DriveApp.getFolderById(CONF.getProperty('INBOX_FOLDER_ID'));
  var it = inbox.getFoldersByName(cid);
  if (!it.hasNext()) return json_({ ok: false, error: 'not_found' });
  var meta = readJsonFile_(it.next());
  if (!meta || !meta.person) return json_({ ok: false, error: 'not_processed' });

  /* vault 경로 탐색: BusinessCards → 00_Inbox → Kairen → 02_Kairen_OS/30_Instance/Person */
  var p1 = inbox.getParents(); if (!p1.hasNext()) return json_({ ok: false, error: 'vault_walk_failed' });
  var p2 = p1.next().getParents(); if (!p2.hasNext()) return json_({ ok: false, error: 'vault_walk_failed' });
  var kairen = p2.next();
  var personFolder = subFolder_(subFolder_(subFolder_(kairen, '02_Kairen_OS'), '30_Instance'), 'Person');
  if (!personFolder) return json_({ ok: false, error: 'person_folder_not_found' });

  var files = personFolder.searchFiles("title contains '" + String(meta.person).replace(/'/g, '') + "'");
  if (!files.hasNext()) return json_({ ok: false, error: 'doc_not_found' });
  var doc = files.next().getBlob().getDataAsString('UTF-8');
  return json_({ ok: true, person: meta.person, markdown: doc.slice(0, 60000) });
}

function subFolder_(folder, name) {
  if (!folder) return null;
  var it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
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
    var brief = readNewestText_(folder, 'brief', '.md');
    if (brief) item.brief = brief.slice(0, 6000);
    items.push(item);
  }
  return json_({ ok: true, name: name, seeAll: seeAll, items: items });
}

function readTextFile_(folder, fname) {
  var it = folder.getFilesByName(fname);
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

/* 접두사·확장자가 맞는 파일 중 '가장 최근 수정본'을 읽는다.
   Drive 동기화가 같은 이름의 중복 파일("capture (1).json" 또는 동명 2개)을 만들어도 최신이 진실. */
function readNewestText_(folder, prefix, suffix) {
  var files = folder.getFiles();
  var best = null;
  while (files.hasNext()) {
    var f = files.next();
    var n = f.getName();
    if (n.indexOf(prefix) === 0 && n.slice(-suffix.length) === suffix) {
      if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
    }
  }
  return best ? best.getBlob().getDataAsString('UTF-8') : null;
}

function readJsonFile_(folder) {
  var txt = readNewestText_(folder, 'capture', '.json');
  if (txt === null) return null;
  try { return JSON.parse(txt); } catch (err) { return null; }
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action === 'correction') return correction_(req);
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
