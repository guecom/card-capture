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
 *   RESEARCH_INSTRUCTION_ENABLED 선택. "false"면 조사 지시 UI/API를 즉시 비활성화 (기본 true)
 *   PUSH_NOTIFICATIONS_ENABLED 선택. 정확히 "true"일 때만 Web Push 경로 활성화 (기본 false)
 *   PUSH_VAPID_PUBLIC_KEY / PUSH_SENDER_TOKEN 필수. private key는 watcher PC의 DPAPI에만 저장
 *   PUSH_REGISTRY_FOLDER_ID 필수. Kairen vault 밖·Restricted Drive 폴더
 *   PUSH_MAX_SUBSCRIPTIONS_PER_SUBJECT 선택. 1~8, 기본 4
 *
 * 클라이언트 계약 (webapp/index.html):
 *   POST body (text/plain, JSON): {
 *     k: 토큰, captureId: "yyyyMMdd-HHmmss-xxxx", capturedAt: ISO문자열,
 *     event: 행사명(선택), note: 한줄메모(선택),
 *     quickName: {name, source, confidence, confirmed, recognizedAt} | null,
 *     images: [{name:"front.jpg"|"back.jpg", mime:"image/jpeg", dataB64:"..."}]
 *   }
 *   GET ?action=ping           → 상태 확인
 *   GET ?action=whoami&k=토큰  → 토큰 유효성/이름 확인
 *   GET ?action=list&k=토큰&limit=30&offset=0 → 브리핑 목록 (토큰 scope, OWNER_NAMES는 전체, hasMore 페이지네이션)
 *   GET ?action=persondoc&k=토큰&captureId=ID → Person .md 전문 (OWNER_NAMES 한정)
 *   GET ?action=search&k=토큰&q=검색어        → Person 검색 (OWNER_NAMES 한정)
 *   GET ?action=doc&k=토큰&id=파일ID          → 검색 결과 Person .md 전문 (OWNER_NAMES 한정, Person 폴더 내부만)
 *   GET ?action=notify                         → 구형 MailApp 알림 퇴역(항상 fail-closed)
 *   POST {action:'requeue', k, captureId}      → 재처리 요청 (자기 캡처, terminal 상태 비후퇴, 10분 dedup)
 *   GET ?action=requeue&k=토큰&captureId=ID   → 구버전 앱 호환용 재처리 요청
 *   POST {action:'correction', k, captureId, text} → 수정 요청 저장 + 재처리 대기 전환
 *   POST {action:'addnote', k, text, captureId|person} → 사후 메모 접수(-note 캡처로 파이프라인 재사용)
 *   POST {action:'manualperson', k, captureId, capturedAt, event, note, text} → 직접 입력 접수
 *        (이미지 없음. type: 'manual_person' capture.json 하나만 쓰고 기존 처리 파이프라인이 집어간다)
 *   POST {action:'researchinstruction', k, text, captureId|person} → owner-only 조사 지시 접수
 *   POST {action:'pushsubscribe', k, keyId, subscription} → 현재 토큰 subject에 Web Push 구독 등록
 *   POST {action:'pushunsubscribe', k, endpoint}   → 현재 토큰 subject의 구독 철회
 *   POST {action:'pushconfig', k}                  → Web Push 사용 가능 여부와 VAPID 공개키
 *   POST {action:'pushstatus', k, endpoint}        → 현재 토큰 subject의 registry 연결 확인
 *   POST {action:'pushsubscriptions', senderToken, subjectId} → watcher 전용 구독 조회
 *   POST {action:'pushretire', senderToken, subscriptionId, revisionId} → watcher 전용 stale 구독 퇴역
 */

var CONF = PropertiesService.getScriptProperties();

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'ping') {
    return json_({ ok: true, service: 'card-capture', time: new Date().toISOString() });
  }
  if (action === 'whoami') {
    var name = capturerFor_(e.parameter.k);
    return json_(name ? {
      ok: true,
      name: name,
      owner: isOwner_(name),
      researchInstructionEnabled: researchInstructionEnabled_(),
      deepResearchEnabled: deepResearchEnabled_(),
      pushNotificationsEnabled: pushNotificationsEnabled_()
    } : { ok: false, error: 'invalid_token' });
  }
  if (action === 'list') {
    return listCaptures_(e.parameter.k, e.parameter.limit, e.parameter.offset);
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
    return notifyProcessed_();
  }
  if (action === 'requeue') {
    return requeue_(e.parameter.k, e.parameter.captureId);
  }
  return json_({ ok: false, error: 'unknown_action' });
}

/* 재처리 요청 — 처리가 오래 걸리거나 이상할 때 사용자가 스스로 다시 큐에 넣는다.
   자기 캡처(또는 owner)만. 서버의 terminal 상태가 stale UI보다 우선하며 절대 received로 후퇴시키지 않는다. */
function requeue_(token, captureId) {
  var name = capturerFor_(token);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  var cid = sanitizeId_(captureId);
  if (!cid) return json_({ ok: false, error: 'bad_capture_id' });
  var inbox = DriveApp.getFolderById(CONF.getProperty('INBOX_FOLDER_ID'));
  var it = inbox.getFoldersByName(cid);
  if (!it.hasNext()) return json_({ ok: false, error: 'not_found' });
  var folder = it.next();
  var meta = readJsonFile_(folder);
  if (!meta) return json_({ ok: false, error: 'no_capture_json' });
  if (meta.capturer !== name && !isOwner_(name)) return json_({ ok: false, error: 'not_your_capture' });
  /* 업로드 경로와 같은 판정을 쓴다 — 두 경로가 갈리면 한쪽만 되돌림을 막게 된다 (FI-015). */
  if (isTerminalMeta_(meta)) {
    return json_({
      ok: true,
      captureId: cid,
      status: meta.status === 'skipped' ? 'skipped' : 'processed',
      alreadyTerminal: true,
      processedAt: meta.processedAt || ''
    });
  }
  /* 같은 원인으로 예산을 다 쓴 영수증은 서버도 거절한다 — 워처가 어차피 무시할 요청에
     200을 돌려주면 화면이 "접수됐다"고 거짓말하게 된다 (TSK-000531). */
  if (meta.recovery && String(meta.recovery.kind || '') === 'recovery_required') {
    return json_({ ok: false, error: 'recovery_required', captureId: cid });
  }
  var cache = CacheService.getScriptCache();
  var key = 'rq_' + cid;
  if (cache.get(key)) return json_({ ok: true, captureId: cid, status: 'received', deduped: true });
  cache.put(key, '1', 10 * 60); /* 10분 dedup — 연타 방지 */
  meta.status = 'received';
  meta.receivedAt = new Date().toISOString();
  meta.requeueRequested = true;
  upsertFile_(folder, 'capture.json',
    Utilities.newBlob(JSON.stringify(meta, null, 2), 'application/json', 'capture.json'));
  return json_({ ok: true, captureId: cid, status: 'received' });
}

/* OWNER_NAMES 판정 */
function isOwner_(name) {
  var owners = String(CONF.getProperty('OWNER_NAMES') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  return owners.indexOf(name) >= 0;
}

/* Rollback switch. 명시적으로 false일 때만 닫아 기존 배포 설정 없이도 승인된 기능이 열린다. */
function researchInstructionEnabled_() {
  return String(CONF.getProperty('RESEARCH_INSTRUCTION_ENABLED') || 'true').toLowerCase() !== 'false';
}

/* Deep Research는 명시적으로 true일 때만 연다. 새 Script Property를 배포에서 빼먹어도
   standard research만 남는 fail-closed 기본값이어야 한다. */
function deepResearchEnabled_() {
  return String(CONF.getProperty('DEEP_RESEARCH_ENABLED') || '').trim().toLowerCase() === 'true';
}

/* Web Push는 live credential·외부 발송 경계다. 정확히 true이고 필요한 공개 설정이 모두
   유효할 때만 구독/발송 경로가 열린다. Code.gs 배포만으로는 절대 켜지지 않는다. */
function pushNotificationsEnabled_() {
  return String(CONF.getProperty('PUSH_NOTIFICATIONS_ENABLED') || '').trim().toLowerCase() === 'true' &&
    /^[A-Za-z0-9_-]{80,120}$/.test(String(CONF.getProperty('PUSH_VAPID_PUBLIC_KEY') || '')) &&
    Boolean(String(CONF.getProperty('PUSH_REGISTRY_FOLDER_ID') || '').trim()) &&
    /^[A-Za-z0-9_-]{32,160}$/.test(String(CONF.getProperty('PUSH_SENDER_TOKEN') || ''));
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

/* DEC-000092: 구형 MailApp 채널은 승인된 알림 채널이 아니다. 예전 watcher가 GET을
   호출해도 외부 효과 없이 명시적으로 퇴역 응답만 준다. */
function notifyProcessed_() {
  return json_({ ok: false, error: 'notification_channel_retired' });
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    String(text || ''), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var value = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += ('0' + value.toString(16)).slice(-2);
  }
  return hex;
}

/* 같은 표시 이름을 쓰는 서로 다른 토큰이 서로의 알림을 받지 않도록 token 자체가 아닌
   server-derived opaque subject만 capture receipt와 registry 사이의 routing key로 쓴다. */
function pushSubjectId_(token) {
  if (!capturerFor_(token)) return '';
  return 'psh-' + sha256Hex_('card-capture-push-v1\u0000' + String(token));
}

function pushRoutingTag_(captureId, subjectId) {
  var senderToken = String(CONF.getProperty('PUSH_SENDER_TOKEN') || '');
  if (!/^[A-Za-z0-9_-]{32,160}$/.test(senderToken) ||
      !/^[A-Za-z0-9_-]{4,80}$/.test(String(captureId || '')) ||
      !/^psh-[a-f0-9]{64}$/.test(String(subjectId || ''))) return '';
  var bytes = Utilities.computeHmacSha256Signature(
    'card-capture-push-route-v1\u0000' + String(captureId) + '\u0000' + String(subjectId), senderToken);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var value = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += ('0' + value.toString(16)).slice(-2);
  }
  return 'prt-' + hex;
}

function pushKeyId_() {
  var key = String(CONF.getProperty('PUSH_VAPID_PUBLIC_KEY') || '');
  return key ? 'vpk-' + sha256Hex_(key).slice(0, 20) : '';
}

function pushMaxSubscriptions_() {
  var value = parseInt(CONF.getProperty('PUSH_MAX_SUBSCRIPTIONS_PER_SUBJECT') || '4', 10);
  return Math.min(Math.max(isFinite(value) ? value : 4, 1), 8);
}

function pushRegistryFolder_() {
  var id = String(CONF.getProperty('PUSH_REGISTRY_FOLDER_ID') || '').trim();
  var inboxId = String(CONF.getProperty('INBOX_FOLDER_ID') || '').trim();
  if (!id || !inboxId || id === inboxId) return null;
  try {
    var registry = DriveApp.getFolderById(id);
    var inbox = DriveApp.getFolderById(inboxId);
    var inboxParent = inbox.getParents(); if (!inboxParent.hasNext()) return null;
    var vaultParent = inboxParent.next().getParents(); if (!vaultParent.hasNext()) return null;
    var vaultRoot = vaultParent.next();
    /* endpoint와 encryption key는 synced vault 안에 들어가면 안 된다. BusinessCards와
       같은 Kairen root 아래의 어느 하위 폴더도 fail-closed한다. */
    var cursor = [registry];
    var seen = {};
    for (var depth = 0; cursor.length && depth < 16; depth++) {
      var folder = cursor.shift();
      var folderId = String(folder.getId());
      if (seen[folderId]) continue;
      seen[folderId] = true;
      if (folderId === String(vaultRoot.getId())) return null;
      var parents = folder.getParents();
      while (parents.hasNext()) cursor.push(parents.next());
    }
    if (cursor.length) return null; /* ancestor graph가 경계를 넘으면 vault 밖임을 증명하지 못했다. */
    if (typeof registry.getSharingAccess !== 'function' ||
        registry.getSharingAccess() !== DriveApp.Access.PRIVATE) return null;
    return registry;
  } catch (err) { return null; }
}

function pushConfig_(token) {
  if (!capturerFor_(token)) return json_({ ok: false, error: 'invalid_token' });
  var enabled = pushNotificationsEnabled_() && Boolean(pushRegistryFolder_());
  var response = {
    ok: true,
    enabled: enabled,
    transport: 'direct_web_push_v1',
    maxDevices: pushMaxSubscriptions_()
  };
  if (enabled) {
    response.publicKey = String(CONF.getProperty('PUSH_VAPID_PUBLIC_KEY'));
    response.keyId = pushKeyId_();
  }
  return json_(response);
}

function normalizePushSubscription_(value) {
  if (!value || typeof value !== 'object') return null;
  var endpoint = String(value.endpoint || '');
  /* ISS-000045의 현재 범위는 Android Chrome이다. arbitrary URL SSRF를 막기 위해 Chrome의
     standards-based FCM Web Push endpoint만 registry와 sender 양쪽에서 허용한다. */
  if (endpoint.length > 2048 ||
      !/^https:\/\/fcm\.googleapis\.com\/(?:fcm\/send|wp)\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{20,1900}$/.test(endpoint)) return null;
  var keys = value.keys && typeof value.keys === 'object' ? value.keys : {};
  var p256dh = String(keys.p256dh || '');
  var auth = String(keys.auth || '');
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,40}$/.test(auth)) return null;
  if (value.expirationTime !== null && value.expirationTime !== undefined &&
      (typeof value.expirationTime !== 'number' || !isFinite(value.expirationTime))) return null;
  return { endpoint: endpoint, expirationTime: value.expirationTime || null, keys: { p256dh: p256dh, auth: auth } };
}

function pushSubscriptionId_(endpoint) {
  return 'psub-' + sha256Hex_('card-capture-subscription-v1\u0000' + String(endpoint));
}

function readPushRecord_(folder, subscriptionId) {
  var files = folder.getFilesByName(subscriptionId + '.json');
  if (!files.hasNext()) return null;
  try { return JSON.parse(files.next().getBlob().getDataAsString('UTF-8')); } catch (err) { return null; }
}

function pushSubscribe_(req) {
  var subjectId = pushSubjectId_(req.k);
  if (!subjectId) return json_({ ok: false, error: 'invalid_token' });
  if (!pushNotificationsEnabled_()) return json_({ ok: false, error: 'feature_disabled' });
  var subscription = normalizePushSubscription_(req.subscription);
  if (!subscription) return json_({ ok: false, error: 'bad_subscription' });
  var folder = pushRegistryFolder_();
  if (!folder) return json_({ ok: false, error: 'registry_unavailable' });
  var subscriptionId = pushSubscriptionId_(subscription.endpoint);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var currentKeyId = pushKeyId_();
    if (String(req.keyId || '') !== currentKeyId) return json_({ ok: false, error: 'key_changed' });
    var prior = readPushRecord_(folder, subscriptionId);
    if (prior && String(prior.endpoint || '') !== subscription.endpoint) {
      return json_({ ok: false, error: 'subscription_hash_conflict' });
    }
    if (prior && String(prior.subjectId || '') !== subjectId && activePushSubject_(String(prior.subjectId || ''))) {
      return json_({ ok: false, error: 'subscription_subject_conflict' });
    }
    if (!prior) {
      var activeForSubject = 0;
      var files = folder.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        if (!/^psub-[a-f0-9]{64}\.json$/.test(file.getName())) continue;
        try {
          var row = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
          if (row && row.status === 'active' && row.subjectId === subjectId) activeForSubject++;
        } catch (ignoredRecordError) {}
      }
      if (activeForSubject >= pushMaxSubscriptions_()) return json_({ ok: false, error: 'subscription_limit' });
    }
    var now = new Date().toISOString();
    var record = {
      version: 'card-capture-push-subscription-v1',
      subscriptionId: subscriptionId,
      subjectId: subjectId,
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: subscription.keys,
      keyId: currentKeyId,
      revisionId: 'prv-' + String(Utilities.getUuid()).replace(/-/g, '').toLowerCase(),
      status: 'active',
      createdAt: prior && prior.subjectId === subjectId && prior.createdAt ? String(prior.createdAt) : now,
      updatedAt: now
    };
    upsertFile_(folder, subscriptionId + '.json',
      Utilities.newBlob(JSON.stringify(record, null, 2), 'application/json', subscriptionId + '.json'));
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, subscriptionId: subscriptionId, active: true });
}

function trashPushRecord_(folder, subscriptionId) {
  var files = folder.getFilesByName(subscriptionId + '.json');
  var removed = false;
  while (files.hasNext()) {
    var file = files.next();
    if (typeof file.setTrashed === 'function') { file.setTrashed(true); removed = true; }
  }
  return removed;
}

function pushUnsubscribe_(req) {
  var subjectId = pushSubjectId_(req.k);
  if (!subjectId) return json_({ ok: false, error: 'invalid_token' });
  var endpoint = String(req.endpoint || '');
  if (!endpoint || endpoint.length > 2048) return json_({ ok: false, error: 'bad_subscription' });
  var folder = pushRegistryFolder_();
  if (!folder) return json_({ ok: true, active: false, registryUnavailable: true });
  var subscriptionId = pushSubscriptionId_(endpoint);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var prior = readPushRecord_(folder, subscriptionId);
    if (!prior) return json_({ ok: true, active: false, deduped: true });
    if (String(prior.subjectId || '') !== subjectId || String(prior.endpoint || '') !== endpoint) {
      return json_({ ok: false, error: 'subscription_subject_conflict' });
    }
    trashPushRecord_(folder, subscriptionId);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, active: false });
}

function pushStatus_(req) {
  var subjectId = pushSubjectId_(req.k);
  if (!subjectId) return json_({ ok: false, error: 'invalid_token' });
  var endpoint = String(req.endpoint || '');
  if (!endpoint || endpoint.length > 2048) return json_({ ok: false, error: 'bad_subscription' });
  var folder = pushRegistryFolder_();
  if (!folder) return json_({ ok: true, active: false });
  var record = readPushRecord_(folder, pushSubscriptionId_(endpoint));
  return json_({
    ok: true,
    active: Boolean(record && record.status === 'active' && record.subjectId === subjectId &&
      record.endpoint === endpoint && record.keyId === pushKeyId_())
  });
}

function pushSenderAuthorized_(token) {
  var expected = String(CONF.getProperty('PUSH_SENDER_TOKEN') || '');
  return expected.length >= 32 && String(token || '') === expected;
}

function activePushSubject_(subjectId) {
  try {
    var tokens = JSON.parse(CONF.getProperty('TOKENS') || '{}');
    var keys = Object.keys(tokens);
    for (var i = 0; i < keys.length; i++) {
      if (capturerFor_(keys[i]) && 'psh-' + sha256Hex_('card-capture-push-v1\u0000' + keys[i]) === subjectId) return true;
    }
  } catch (err) {}
  return false;
}

function pushSubscriptions_(req) {
  if (!pushSenderAuthorized_(req.senderToken)) return json_({ ok: false, error: 'sender_unauthorized' });
  if (!pushNotificationsEnabled_()) return json_({ ok: false, error: 'feature_disabled' });
  var subjectId = String(req.subjectId || '');
  if (!/^psh-[a-f0-9]{64}$/.test(subjectId)) return json_({ ok: false, error: 'bad_subject' });
  if (!activePushSubject_(subjectId)) return json_({ ok: true, keyId: pushKeyId_(), subscriptions: [], subjectInactive: true });
  var folder = pushRegistryFolder_();
  if (!folder) return json_({ ok: false, error: 'registry_unavailable' });
  var currentKeyId = pushKeyId_();
  var subscriptions = [];
  var files = folder.getFiles();
  while (files.hasNext() && subscriptions.length < pushMaxSubscriptions_()) {
    var file = files.next();
    if (!/^psub-[a-f0-9]{64}\.json$/.test(file.getName())) continue;
    try {
      var record = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if (!record || record.status !== 'active' || record.subjectId !== subjectId || record.keyId !== currentKeyId) continue;
      var normalized = normalizePushSubscription_(record);
      if (!normalized || record.subscriptionId !== pushSubscriptionId_(normalized.endpoint)) continue;
      subscriptions.push({
        subscriptionId: record.subscriptionId,
        revisionId: record.revisionId,
        endpoint: normalized.endpoint,
        expirationTime: normalized.expirationTime,
        keys: normalized.keys
      });
    } catch (ignoredSubscriptionError) {}
  }
  return json_({ ok: true, keyId: currentKeyId, subscriptions: subscriptions });
}

function pushRetire_(req) {
  if (!pushSenderAuthorized_(req.senderToken)) return json_({ ok: false, error: 'sender_unauthorized' });
  var subscriptionId = String(req.subscriptionId || '');
  if (!/^psub-[a-f0-9]{64}$/.test(subscriptionId)) return json_({ ok: false, error: 'bad_subscription_id' });
  var revisionId = String(req.revisionId || '');
  if (!/^prv-[a-f0-9]{32}$/.test(revisionId)) return json_({ ok: false, error: 'bad_revision_id' });
  var folder = pushRegistryFolder_();
  if (!folder) return json_({ ok: false, error: 'registry_unavailable' });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var prior = readPushRecord_(folder, subscriptionId);
    if (!prior) return json_({ ok: true, retired: false, deduped: true });
    if (String(prior.revisionId || '') !== revisionId) return json_({ ok: true, retired: false, staleRevision: true });
    return json_({ ok: true, retired: trashPushRecord_(folder, subscriptionId) });
  } finally {
    lock.releaseLock();
  }
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

/* 브리핑 목록: 토큰 소유자의 캡처(OWNER_NAMES에 있으면 전체)를 최신순으로 반환.
   limit(기본 30, 최대 100)·offset으로 과거 캡처까지 조회할 수 있다(더 보기). */
function listCaptures_(token, limitParam, offsetParam) {
  var name = capturerFor_(token);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  var seeAll = isOwner_(name);
  var inboxId = CONF.getProperty('INBOX_FOLDER_ID');
  if (!inboxId) return json_({ ok: false, error: 'not_configured' });
  var limit = Math.min(Math.max(parseInt(limitParam, 10) || 30, 1), 100);
  var offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

  var folders = DriveApp.getFolderById(inboxId).getFolders();
  var entries = [];
  while (folders.hasNext()) entries.push(folders.next());
  entries.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; }); /* captureId 최신순 */

  var items = [];
  var mineSeen = 0;
  var hasMore = false;
  for (var i = 0; i < entries.length; i++) {
    var folder = entries[i];
    var meta = readJsonFile_(folder);
    if (!meta) continue;
    if (!seeAll && String(meta.capturer || '') !== name) continue;
    mineSeen++;
    if (mineSeen <= offset) continue;
    if (items.length >= limit) { hasMore = true; break; }
    var item = {
      captureId: meta.captureId || folder.getName(),
      capturer: meta.capturer || '',
      capturedAt: meta.capturedAt || '',
      receivedAt: meta.receivedAt || '',
      processedAt: meta.processedAt || '',
      event: meta.event || '',
      status: meta.status || 'received',
      person: meta.person || '',
      personAction: meta.personAction || '',
      type: meta.type || 'capture',
      contact: meta.contact || null,
      quickName: meta.quickName || null
    };
    var attentionAt = meta.attention && String(meta.attention.requestedAt || meta.processedAt || '');
    if (meta.status === 'skipped' && meta.attention && meta.attention.kind === 'input_required' &&
        ['unreadable_capture', 'missing_required_side', 'identity_ambiguous'].indexOf(String(meta.attention.reasonCode || '')) >= 0 &&
        attentionAt && !isNaN(Date.parse(attentionAt))) {
      item.attention = {
        kind: 'input_required',
        reasonCode: String(meta.attention.reasonCode),
        requestedAt: attentionAt.slice(0, 40)
      };
    }
    /* 반복 실패로 잠긴 영수증은 화면이 알아야 `다시 처리`를 내밀지 않는다 (TSK-000531).
       투영은 allowlist다 — 워처가 쓴 closed enum만 통과시키고, 원인 문자열을 그대로 흘리지 않는다. */
    if (meta.recovery && !isTerminalMeta_(meta) &&
        ['retry_scheduled', 'recovery_required'].indexOf(String(meta.recovery.kind || '')) >= 0 &&
        ['processor_failed', 'processor_timeout', 'result_incomplete', 'internal_state_failed', 'unknown_failure']
          .indexOf(String(meta.recovery.reasonCode || '')) >= 0) {
      item.recovery = {
        kind: String(meta.recovery.kind),
        reasonCode: String(meta.recovery.reasonCode),
        attempts: Number(meta.recovery.attempts) || 0,
        failures: Number(meta.recovery.failures) || 0,
        threshold: Number(meta.recovery.threshold) || 0,
        since: String(meta.recovery.since || '').slice(0, 40)
      };
    }
    if (meta.researchInstruction) {
      item.researchInstruction = {
        mode: meta.researchInstruction.mode || 'standard',
        purposes: meta.researchInstruction.purposes || [],
        focusIds: meta.researchInstruction.focusIds || [],
        sourceAuthority: 'public_lawful_only',
        policyVersion: meta.researchInstruction.policy && meta.researchInstruction.policy.version || 'public-research-v1'
      };
    }
    if (meta.type === 'research_instruction' && meta.researchInstruction &&
        meta.researchInstruction.mode === 'deep_evidence_graph' && meta.researchProgress) {
      var publishedProgress = validateResearchProgress_(meta.researchProgress);
      var processingCheckpoint = meta.status === 'processing' && publishedProgress &&
        publishedProgress.phase !== 'done' && publishedProgress.partial === true;
      var completedCheckpoint = meta.status === 'processed' && publishedProgress &&
        publishedProgress.phase === 'done' && publishedProgress.partial === false;
      if (processingCheckpoint || completedCheckpoint) item.researchProgress = publishedProgress;
    }
    var brief = readNewestText_(folder, 'brief', '.md');
    if (brief) item.brief = brief.slice(0, 6000);
    if (seeAll && meta.type === 'research_instruction' && meta.status === 'processed' &&
        meta.researchInstruction && meta.researchInstruction.mode === 'deep_evidence_graph') {
      var evidenceText = readNewestText_(folder, 'research-result', '.json');
      if (evidenceText) {
        try {
          var evidence = JSON.parse(evidenceText);
          var publishedEvidence = validateResearchEvidenceGraph_(evidence);
          if (publishedEvidence && sameStringArray_(publishedEvidence.purposes, meta.researchInstruction.purposes)) {
            item.researchEvidence = publishedEvidence;
          }
        } catch (ignoredEvidenceError) {}
      }
    }
    items.push(item);
  }
  return json_({
    ok: true,
    name: name,
    seeAll: seeAll,
    researchInstructionEnabled: researchInstructionEnabled_(),
    deepResearchEnabled: deepResearchEnabled_(),
    items: items,
    offset: offset,
    hasMore: hasMore
  });
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
    if (req.action === 'pushconfig') return pushConfig_(req.k);
    if (req.action === 'pushstatus') return pushStatus_(req);
    if (req.action === 'pushsubscribe') return pushSubscribe_(req);
    if (req.action === 'pushunsubscribe') return pushUnsubscribe_(req);
    if (req.action === 'pushsubscriptions') return pushSubscriptions_(req);
    if (req.action === 'pushretire') return pushRetire_(req);
    if (req.action === 'requeue') return requeue_(req.k, req.captureId);
    if (req.action === 'correction') return correction_(req);
    if (req.action === 'addnote') return addNote_(req);
    if (req.action === 'manualperson') return manualPerson_(req);
    if (req.action === 'researchinstruction') return researchInstruction_(req);
    var name = capturerFor_(req.k);
    if (!name) return json_({ ok: false, error: 'invalid_token' });
    var researchRequest = normalizeResearchRequest_(req.researchInstruction);
    if (req.researchInstruction && !researchRequest) return json_({ ok: false, error: 'bad_research_request' });
    if (researchRequest && !researchInstructionEnabled_()) return json_({ ok: false, error: 'feature_disabled' });
    if (researchRequest && researchRequest.mode === 'deep_evidence_graph' && !deepResearchEnabled_()) return json_({ ok: false, error: 'deep_feature_disabled' });
    if (researchRequest && !isOwner_(name)) return json_({ ok: false, error: 'owner_only' });
    if (!withinDailyLimit_(req.k)) return json_({ ok: false, error: 'daily_limit' });

    var captureId = sanitizeId_(req.captureId) || newId_();
    var images = (req.images || []).slice(0, 4);
    if (!images.length) return json_({ ok: false, error: 'no_images' });

    /* 업로드 전체를 먼저 검증하고, 전부 통과한 뒤에만 쓴다 (FI-011 / FI-012 / FI-013).
       예전에는 루프 안에서 바로 써서 (a) 뒤쪽 이미지가 실패하면 앞쪽만 남는 부분 커밋이 생기고,
       (b) 클라이언트가 준 파일 이름이 그대로 저장 이름이 됐다. (b)는 `brief.md`·`capture.json`처럼
       **처리 파이프라인이 소유한 산출물 슬롯을 업로드로 덮어쓸 수 있다는 뜻**이었다. */
    var planned = [];
    var usedSlots = {};
    for (var i = 0; i < images.length; i++) {
      var img = images[i] || {};
      var slot = captureSlotName_(img.name);
      if (!slot) return json_({ ok: false, error: 'bad_image_name' });
      if (usedSlots[slot]) return json_({ ok: false, error: 'duplicate_image_slot', file: slot });
      usedSlots[slot] = true;
      var bytes;
      try {
        bytes = Utilities.base64Decode(img.dataB64);
      } catch (decodeErr) {
        return json_({ ok: false, error: 'bad_image_data', file: slot });
      }
      if (!bytes || !bytes.length) return json_({ ok: false, error: 'empty_image', file: slot });
      if (bytes.length > 8 * 1024 * 1024) return json_({ ok: false, error: 'image_too_large', file: slot });
      planned.push({ slot: slot, bytes: bytes, mime: img.mime || 'image/jpeg' });
    }

    var inboxId = CONF.getProperty('INBOX_FOLDER_ID');
    if (!inboxId) return json_({ ok: false, error: 'not_configured' });
    var inbox = DriveApp.getFolderById(inboxId);

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    var folder;
    var existed;
    try {
      var it = inbox.getFoldersByName(captureId);
      existed = it.hasNext();
      folder = existed ? it.next() : inbox.createFolder(captureId);
    } finally {
      lock.releaseLock();
    }

    /* 같은 captureId가 이미 있으면 소유자·내용·처리 상태를 먼저 판정한다
       (FI-009 ownership / FI-010 idempotency / FI-015 lifecycle monotonicity). */
    var prior = existed ? readJsonFile_(folder) : null;
    if (prior && prior.capturer && prior.capturer !== name && !isOwner_(name)) {
      /* 남의 캡처 폴더에 덮어쓸 수 없다. 파일·메타는 하나도 건드리지 않는다. */
      return json_({ ok: false, error: 'capture_conflict' });
    }

    var fingerprint = uploadFingerprint_(req, images);
    if (sameAsStoredUpload_(prior, req, images, fingerprint)) {
      /* 완전히 같은 업로드가 다시 왔다 — 응답만 유실된 재전송이다.
         파일도 capture.json도 다시 쓰지 않는다. 다시 쓰면 status가 received로
         되돌아가 이미 끝난 처리가 처음부터 다시 돈다. */
      return json_({
        ok: true,
        captureId: captureId,
        files: prior.files || [],
        deduped: true,
        status: prior.status || 'received',
        processedAt: prior.processedAt || ''
      });
    }

    var saved = [];
    for (var p = 0; p < planned.length; p++) {
      upsertFile_(folder, planned[p].slot,
        Utilities.newBlob(planned[p].bytes, planned[p].mime, planned[p].slot));
      saved.push(planned[p].slot);
    }

    var capturePushSubjectId = pushSubjectId_(req.k);
    var meta = {
      captureId: captureId,
      capturer: name,
      pushSubjectId: capturePushSubjectId,
      pushRoutingTag: pushRoutingTag_(captureId, capturePushSubjectId),
      capturedAt: String(req.capturedAt || ''),
      receivedAt: new Date().toISOString(),
      event: String(req.event || '').slice(0, 200),
      note: String(req.note || '').slice(0, 2000),
      quickName: sanitizeQuickName_(req.quickName),
      files: saved,
      uploadFingerprint: fingerprint,
      status: 'received'
    };
    if (prior && isTerminalMeta_(prior)) {
      /* 내용이 실제로 달라진 재업로드다(수정·다시 찍기). 처리를 다시 돌리는 것은 맞지만
         조용한 되돌림으로 남기지 않는다 — requeue와 같은 명시적 표식과 이전 결과를 함께 남긴다. */
      meta.requeueRequested = true;
      meta.previousStatus = prior.status || '';
      meta.previousProcessedAt = prior.processedAt || '';
      if (prior.person) meta.previousPerson = prior.person;
    }
    if (researchRequest) {
      meta.researchRequestFingerprint = researchRequestFingerprint_(researchRequest);
      meta.researchInstruction = researchEnvelope_(researchRequest, name, {
        captureId: captureId
      }, captureId + '-research-1');
    }
    upsertFile_(folder, 'capture.json',
      Utilities.newBlob(JSON.stringify(meta, null, 2), 'application/json', 'capture.json'));

    return json_({ ok: true, captureId: captureId, files: saved });
  } catch (err) {
    return json_({ ok: false, error: 'server_error', detail: String(err) });
  }
}

/* 직접 입력 — 명함 사진 없이 자연어로 사람을 접수한다 (ISS-000231 / DEC-000103).

   founder 요구(INT-000029): "수기로 입력하면 그것을 마치 명함의 정보들을 검색하는 것처럼
   진행해 주는 게 있었으면 좋겠어."

   왜 addNote_처럼 새 폴더를 만들지 않고 업로드와 같은 폴더 계약을 쓰는가:
   직접 입력은 **인물 접수**다(메모는 이미 있는 Person에 붙이는 것이다). 그래서 클라이언트가
   만든 captureId가 그대로 폴더 이름이 되고, 사진 업로드와 **같은 멱등 장치**를 쓴다 —
   같은 captureId + 같은 내용 지문이면 아무것도 다시 쓰지 않는다. 연타·타임아웃 뒤 재시도가
   두 번째 job을 만들지 않게 하는 것이 이 계약의 전부다.

   신원 근거(이메일·전화)는 **클라이언트가 보낸 값을 쓰지 않고 서버가 원문에서 다시 뽑는다.**
   그 근거 하나가 기존 Person에 자동으로 이어 붙일 권한이기 때문이다 — 위조 가능한 자리에
   두면 유효 토큰 보유자가 아무 Person에나 붙을 수 있다. 클라이언트의 추출은 화면 되읽기 전용이다. */
function manualPerson_(req) {
  var name = capturerFor_(req.k);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  if (!withinDailyLimit_(req.k)) return json_({ ok: false, error: 'daily_limit' });
  var text = String(req.text || '').trim().slice(0, 2000);
  if (!text) return json_({ ok: false, error: 'empty_text' });

  var inboxId = CONF.getProperty('INBOX_FOLDER_ID');
  if (!inboxId) return json_({ ok: false, error: 'not_configured' });
  var inbox = DriveApp.getFolderById(inboxId);
  var captureId = sanitizeId_(req.captureId) || newId_();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var folder;
  var existed;
  try {
    var it = inbox.getFoldersByName(captureId);
    existed = it.hasNext();
    folder = existed ? it.next() : inbox.createFolder(captureId);
  } finally {
    lock.releaseLock();
  }

  var prior = existed ? readJsonFile_(folder) : null;
  /* 남의 캡처 폴더에 덮어쓸 수 없다 (FI-009). */
  if (prior && prior.capturer && prior.capturer !== name && !isOwner_(name)) {
    return json_({ ok: false, error: 'capture_conflict' });
  }
  /* 사진 캡처를 글로 덮어쓰지 않는다. 같은 id가 다른 종류로 오면 둘 다 지키기 위해 거절한다. */
  if (prior && String(prior.type || 'capture') !== 'manual_person') {
    return json_({ ok: false, error: 'capture_type_conflict' });
  }

  var fingerprint = manualFingerprint_(req, text);
  if (prior && prior.uploadFingerprint && prior.uploadFingerprint === fingerprint) {
    /* 완전히 같은 접수가 다시 왔다 — 응답만 유실된 재전송이다. capture.json을 다시 쓰지 않는다.
       다시 쓰면 status가 received로 되돌아가 이미 끝난 처리가 처음부터 다시 돈다 (FI-010/FI-015). */
    return json_({
      ok: true,
      captureId: captureId,
      type: 'manual_person',
      files: [],
      deduped: true,
      status: prior.status || 'received',
      processedAt: prior.processedAt || ''
    });
  }

  var manualPushSubjectId = pushSubjectId_(req.k);
  var meta = {
    captureId: captureId,
    type: 'manual_person',
    capturer: name,
    pushSubjectId: manualPushSubjectId,
    pushRoutingTag: pushRoutingTag_(captureId, manualPushSubjectId),
    capturedAt: String(req.capturedAt || ''),
    receivedAt: new Date().toISOString(),
    event: String(req.event || '').slice(0, 200),
    note: String(req.note || '').slice(0, 2000),
    /* 사용자가 적은 원문. untrusted 데이터이며 지시로 승격하지 않는다 (PROCESSING_CONTRACT.md). */
    manualText: text,
    /* 이 주장의 출처. 명함 인쇄면이 아니라 사람의 기억이다 — 확신도를 같게 다루면 브리핑이
       "명함에 그렇게 적혀 있었다"고 말하게 된다. */
    claimSource: 'user-provided',
    identityEvidence: manualIdentityEvidence_(text),
    files: [],
    uploadFingerprint: fingerprint,
    status: 'received'
  };
  if (prior && isTerminalMeta_(prior)) {
    /* 내용이 실제로 달라진 재접수다. 처리를 다시 돌리는 것은 맞지만 조용한 되돌림으로 남기지 않는다. */
    meta.requeueRequested = true;
    meta.previousStatus = prior.status || '';
    meta.previousProcessedAt = prior.processedAt || '';
    if (prior.person) meta.previousPerson = prior.person;
  }
  upsertFile_(folder, 'capture.json',
    Utilities.newBlob(JSON.stringify(meta, null, 2), 'application/json', 'capture.json'));

  return json_({ ok: true, captureId: captureId, type: 'manual_person', files: [] });
}

/* 직접 입력 내용 지문 (FI-010과 같은 역할).
   원문이 최대 2,000자라 그대로 담지 않고 해시로 줄인다 — 원문은 이미 manualText에 있다. */
function manualFingerprint_(req, text) {
  return 'manual-' + sha256Hex_([
    String(req.capturedAt || ''),
    String(req.event || '').slice(0, 200),
    String(req.note || '').slice(0, 2000),
    text
  ].join('#'));
}

/* 원문에서 신원 근거를 뽑는다. 여기가 authoritative다 — 클라이언트 값은 쓰지 않는다.

   좁게 잡는다: 국내 표기(0으로 시작, 9~14자리)로 환원되는 번호만 근거로 인정한다.
   날짜나 주문번호가 전화번호로 통과하면 엉뚱한 사람에게 자동 연결된다. 근거를 놓쳐 새 인물이
   하나 더 생기는 쪽이, 잘못 병합되는 쪽보다 언제나 낫다. */
var MANUAL_EMAIL_RE_ = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
var MANUAL_PHONE_RE_ = /\+?\d[\d\s.\-()]{7,}\d/g;

function manualNormalizedPhone_(value) {
  var digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.indexOf('82') === 0) digits = '0' + digits.slice(2);
  return /^0\d{8,13}$/.test(digits) ? digits : '';
}

function manualIdentityEvidence_(text) {
  var source = String(text || '');
  var emails = [];
  (source.match(MANUAL_EMAIL_RE_) || []).forEach(function (raw) {
    var value = String(raw).toLowerCase();
    if (emails.indexOf(value) < 0) emails.push(value);
  });
  var phones = [];
  /* 이메일 안의 숫자가 번호로 잡히면 안 된다 — 먼저 지우고 찾는다. */
  (source.replace(MANUAL_EMAIL_RE_, ' ').match(MANUAL_PHONE_RE_) || []).forEach(function (raw) {
    var value = manualNormalizedPhone_(raw);
    if (value && phones.indexOf(value) < 0) phones.push(value);
  });
  return { emails: emails, phones: phones, source: 'server_derived' };
}

/* 사후 메모 — 사람을 만난 뒤(회의 후·나중에 기억났을 때) Person에 붙일 메모를 접수한다.
   note 캡처 폴더(<시각>-note)를 만들어 기존 처리 파이프라인이 자연히 집어가게 한다
   (CardCapture_Processing 규칙 2-2가 Person Relationship Context에 병합).
   대상 지정: captureId(자기 캡처 또는 owner) 또는 person=PER-XXXXXX(owner 전용, 검색 결과에서). */
function addNote_(req) {
  var name = capturerFor_(req.k);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  if (!withinDailyLimit_(req.k)) return json_({ ok: false, error: 'daily_limit' });
  var text = String(req.text || '').trim().slice(0, 2000);
  if (!text) return json_({ ok: false, error: 'empty_text' });
  var inboxId = CONF.getProperty('INBOX_FOLDER_ID');
  if (!inboxId) return json_({ ok: false, error: 'not_configured' });
  var inbox = DriveApp.getFolderById(inboxId);

  var person = '';
  var relatedCaptureId = '';
  if (req.captureId) {
    var cid = sanitizeId_(req.captureId);
    if (!cid) return json_({ ok: false, error: 'bad_capture_id' });
    var it = inbox.getFoldersByName(cid);
    if (!it.hasNext()) return json_({ ok: false, error: 'not_found' });
    var meta = readJsonFile_(it.next());
    if (!meta) return json_({ ok: false, error: 'no_capture_json' });
    if (meta.capturer !== name && !isOwner_(name)) return json_({ ok: false, error: 'not_your_capture' });
    if (!meta.person) return json_({ ok: false, error: 'not_processed' });
    person = String(meta.person);
    relatedCaptureId = cid;
  } else if (req.person) {
    if (!isOwner_(name)) return json_({ ok: false, error: 'owner_only' });
    if (!/^PER-\d{6}$/.test(String(req.person))) return json_({ ok: false, error: 'bad_person_id' });
    person = String(req.person);
  } else {
    return json_({ ok: false, error: 'no_target' });
  }

  var noteId = newId_() + '-note';
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var folder;
  try {
    folder = inbox.createFolder(noteId);
  } finally {
    lock.releaseLock();
  }
  var notePushSubjectId = pushSubjectId_(req.k);
  var noteMeta = {
    captureId: noteId,
    type: 'note',
    capturer: name,
    pushSubjectId: notePushSubjectId,
    pushRoutingTag: pushRoutingTag_(noteId, notePushSubjectId),
    person: person,
    relatedCaptureId: relatedCaptureId,
    note: text,
    receivedAt: new Date().toISOString(),
    status: 'received'
  };
  folder.createFile(Utilities.newBlob(JSON.stringify(noteMeta, null, 2), 'application/json', 'capture.json'));
  return json_({ ok: true, noteId: noteId, person: person });
}

/* Owner-only 조사 지시. 원문은 provenance 데이터로만 저장하고 서버 고정 policy snapshot을 붙인다.
   실제 실행은 CardCapture_Processing의 bounded-plan 규칙이 담당하며 이 action은 그 경계를 바꾸지 않는다. */
function researchInstruction_(req) {
  var name = capturerFor_(req.k);
  if (!name) return json_({ ok: false, error: 'invalid_token' });
  if (!isOwner_(name)) return json_({ ok: false, error: 'owner_only' });
  if (!researchInstructionEnabled_()) return json_({ ok: false, error: 'feature_disabled' });
  var request = normalizeResearchRequest_(req.instruction || req.text);
  if (!request) return json_({ ok: false, error: 'bad_research_request' });
  if (request.mode === 'deep_evidence_graph' && !deepResearchEnabled_()) return json_({ ok: false, error: 'deep_feature_disabled' });

  var inboxId = CONF.getProperty('INBOX_FOLDER_ID');
  if (!inboxId) return json_({ ok: false, error: 'not_configured' });
  var inbox = DriveApp.getFolderById(inboxId);
  var person = '';
  var relatedCaptureId = '';

  if (req.captureId) {
    var cid = sanitizeId_(req.captureId);
    if (!cid) return json_({ ok: false, error: 'bad_capture_id' });
    var captures = inbox.getFoldersByName(cid);
    if (!captures.hasNext()) return json_({ ok: false, error: 'not_found' });
    var captureMeta = readJsonFile_(captures.next());
    if (!captureMeta) return json_({ ok: false, error: 'no_capture_json' });
    if (!captureMeta.person) return json_({ ok: false, error: 'not_processed' });
    person = String(captureMeta.person);
    relatedCaptureId = cid;
  }

  if (req.person) {
    var requestedPerson = String(req.person);
    if (!/^PER-\d{6}$/.test(requestedPerson)) return json_({ ok: false, error: 'bad_person_id' });
    if (person && person !== requestedPerson) return json_({ ok: false, error: 'target_mismatch' });
    person = requestedPerson;
  }
  if (!person) return json_({ ok: false, error: 'no_target' });

  var requestId = sanitizeRequestId_(request.requestId);
  var researchId = requestId ? 'research-' + requestId : newId_() + '-research';
  var target = { person: person, captureId: relatedCaptureId };
  var requestFingerprint = researchRequestFingerprint_(request);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var folder;
  var instruction;
  var researchMeta;
  var createdFolder = false;
  var chargedQuota = false;
  var recoveryKey = 'RESEARCH_RECEIPT_RESERVATION_' + researchId;
  var recoveryReservation = JSON.stringify({ requestedBy: name, target: target, requestFingerprint: requestFingerprint });
  try {
    var existing = inbox.getFoldersByName(researchId);
    if (existing.hasNext()) {
      var existingFolder = existing.next();
      var existingMeta = readJsonFile_(existingFolder);
      if (sameResearchReceipt_(existingMeta, name, target, requestFingerprint)) {
        return json_({
          ok: true,
          receiptId: researchId,
          person: person,
          status: existingMeta.status || 'received',
          deduped: true
        });
      }
      /* createFolder 뒤 capture.json 쓰기 전에 런타임이 죽었거나 rollback이 실패한 경우에만
         durable Script Property reservation과 일치하는 빈 폴더를 복구한다. CacheService eviction은
         복구 권한을 지우지 않으며, 파일이 하나라도 있으면 다른 요청의 공간일 수 있어 닫는다. */
      if (existingMeta || folderHasAnyFiles_(existingFolder) || CONF.getProperty(recoveryKey) !== recoveryReservation) {
        return json_({ ok: false, error: 'request_id_conflict' });
      }
      folder = existingFolder;
    }
    if (!folder) {
      /* 멱등 판정이 먼저다. 응답만 유실된 동일 requestId 재시도는 일일 quota를 다시 쓰지 않는다. */
      if (!withinDailyLimit_(req.k)) return json_({ ok: false, error: 'daily_limit' });
      chargedQuota = true;
      try {
        CONF.setProperty(recoveryKey, recoveryReservation);
      } catch (reservationError) {
        refundDailyLimit_(req.k);
        return json_({ ok: false, error: 'receipt_reservation_failed' });
      }
      try {
        folder = inbox.createFolder(researchId);
      } catch (folderError) {
        refundDailyLimit_(req.k);
        if (typeof CONF.deleteProperty === 'function') CONF.deleteProperty(recoveryKey);
        return json_({ ok: false, error: 'receipt_folder_failed' });
      }
      createdFolder = true;
    }
    instruction = researchEnvelope_(request, name, target, researchId);
    var researchPushSubjectId = pushSubjectId_(req.k);
    researchMeta = {
      captureId: researchId,
      type: 'research_instruction',
      capturer: name,
      pushSubjectId: researchPushSubjectId,
      pushRoutingTag: pushRoutingTag_(researchId, researchPushSubjectId),
      person: person,
      relatedCaptureId: relatedCaptureId,
      researchRequestFingerprint: requestFingerprint,
      researchInstruction: instruction,
      receivedAt: instruction.requestedAt,
      status: 'received'
    };
    /* 폴더 생성과 canonical receipt 쓰기를 같은 script lock 안에서 끝낸다. 다른 재시도가
       빈 폴더만 보고 requestId collision으로 오판하는 창을 남기지 않는다. */
    try {
      folder.createFile(Utilities.newBlob(JSON.stringify(researchMeta, null, 2), 'application/json', 'capture.json'));
    } catch (writeError) {
      /* 새 폴더는 가능한 한 trash로 되돌리고 quota도 환불한다. trash 자체가 실패해 빈 폴더가
         남더라도 다음 동일 요청은 위 recovery 경로에서 quota 없이 capture.json을 완성한다. */
      if (chargedQuota) refundDailyLimit_(req.k);
      var rolledBack = false;
      if (createdFolder && folder && typeof folder.setTrashed === 'function') {
        try { folder.setTrashed(true); rolledBack = true; } catch (ignoredRollbackError) {}
      }
      if (rolledBack && typeof CONF.deleteProperty === 'function') CONF.deleteProperty(recoveryKey);
      return json_({ ok: false, error: 'receipt_write_failed' });
    }
    if (typeof CONF.deleteProperty === 'function') CONF.deleteProperty(recoveryKey);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, receiptId: researchId, person: person, status: 'received' });
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
  var key = dailyLimitKey_(token);
  var n = parseInt(cache.get(key) || '0', 10) + 1;
  cache.put(key, String(n), 24 * 60 * 60);
  return n <= limit;
}

function dailyLimitKey_(token) {
  return 'cnt_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd') + '_' + token;
}

function refundDailyLimit_(token) {
  var cache = CacheService.getScriptCache();
  var key = dailyLimitKey_(token);
  var n = parseInt(cache.get(key) || '0', 10);
  cache.put(key, String(Math.max(0, n - 1)), 24 * 60 * 60);
}

function folderHasAnyFiles_(folder) {
  if (!folder || typeof folder.getFiles !== 'function') return true;
  var files = folder.getFiles();
  return files && files.hasNext();
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

/* 명함 이미지가 들어갈 수 있는 캡처 폴더 슬롯. 이 목록이 전부다 (FI-013).

   이름을 **서버가 소유한다.** 클라이언트가 준 이름은 슬롯 지정 힌트일 뿐이고,
   목록에 없으면 업로드를 거절한다. `sanitizeName_`으로 문자만 걸러 쓰던 예전 방식은
   `brief.md`·`capture.json`·`correction*.json`처럼 **처리 파이프라인이 소유한 산출물 이름**을
   통과시켰다. 그러면 유효 토큰 보유자가 owner의 브리핑 목록에 임의 텍스트를 시스템 생성
   브리핑으로 띄울 수 있다(`listCaptures_`가 `brief*.md` 최신본을 `item.brief`로 내려주기 때문).
   슬롯 allowlist는 그 표면을 통째로 없앤다. */
var CAPTURE_IMAGE_SLOTS = ['front.jpg', 'back.jpg'];

function captureSlotName_(name) {
  if (name === null || name === undefined) return null;
  var wanted = String(name).toLowerCase();
  for (var i = 0; i < CAPTURE_IMAGE_SLOTS.length; i++) {
    if (wanted === CAPTURE_IMAGE_SLOTS[i]) return CAPTURE_IMAGE_SLOTS[i];
  }
  return null;
}

/* 기기 OCR 결과는 표시·검증용 힌트일 뿐 Person 식별의 권위 있는 값이 아니다. */
function sanitizeQuickName_(value) {
  if (!value || typeof value !== 'object') return null;
  var name = String(value.name || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return null;
  var allowed = ['device_text_detector', 'device_tesseract', 'user_corrected', 'user_entered'];
  var source = allowed.indexOf(String(value.source || '')) >= 0 ? String(value.source) : 'device_tesseract';
  var confidence = Number(value.confidence || 0);
  if (!isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  return {
    name: name,
    source: source,
    confidence: confidence,
    confirmed: value.confirmed === true,
    recognizedAt: String(value.recognizedAt || '').slice(0, 40)
  };
}

function sanitizeResearchRaw_(value) {
  var raw = value && typeof value === 'object' ? value.raw : value;
  return String(raw || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, 2000);
}

var RESEARCH_PURPOSES_ = ['meeting_preparation', 'expertise_execution', 'authority_interests', 'reputation_risk'];
var RESEARCH_FOCUS_IDS_ = ['expertise', 'authority', 'reputation', 'outcomes', 'interests', 'career', 'company', 'connection'];
/* 계약(`63_Research_Instruction_Contract.md` §Request Contract)의 mode allowlist 그대로다.
   `quick`은 계약에 처음부터 있었는데 이 서버만 빠져 있었다 — 앱이 `빠른 조사`를 보내면 요청
   전체가 `bad_research_request`로 거절됐다. 누락 시 기본값은 계약대로 `standard`다. */
var RESEARCH_MODES_ = ['quick', 'standard', 'deep_evidence_graph'];

function allowedStrings_(values, allowlist) {
  var result = [];
  var input = (Array.isArray(values) ? values : []).map(function (value) { return String(value || ''); });
  allowlist.forEach(function (allowed) {
    if (input.indexOf(allowed) >= 0) result.push(allowed);
  });
  return result;
}

function sanitizeRequestId_(value) {
  var id = String(value || '');
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : '';
}

/* 요청 데이터만 정규화한다. 정책·권한·예산은 researchEnvelope_가 서버 상수로 다시 만든다. */
function normalizeResearchRequest_(value) {
  if (value === null || value === undefined || value === '') return null;
  var input = value && typeof value === 'object' ? value : { raw: value };
  var raw = sanitizeResearchRaw_(input.raw);
  var requestedMode = String(input.mode || '');
  if (input.mode && RESEARCH_MODES_.indexOf(requestedMode) < 0) return null;
  var mode = RESEARCH_MODES_.indexOf(requestedMode) >= 0 ? requestedMode : 'standard';
  var purposes = allowedStrings_(input.purposes, RESEARCH_PURPOSES_);
  var focusIds = allowedStrings_(input.focusIds, RESEARCH_FOCUS_IDS_);
  if (mode === 'deep_evidence_graph' && !purposes.length) return null;
  if (!raw && !focusIds.length && !(mode === 'deep_evidence_graph' && purposes.length)) return null;
  return {
    raw: raw,
    mode: mode,
    purposes: mode === 'deep_evidence_graph' ? purposes : [],
    focusIds: focusIds,
    requestId: sanitizeRequestId_(input.requestId)
  };
}

function researchRequestFingerprint_(requestValue) {
  var request = normalizeResearchRequest_(requestValue);
  if (!request) return '';
  var canonical = JSON.stringify({
    raw: request.raw,
    mode: request.mode,
    purposes: request.purposes,
    focusIds: request.focusIds
  });
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonical, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var value = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += ('0' + value.toString(16)).slice(-2);
  }
  return 'sha256:' + hex;
}

function sameResearchTarget_(stored, expected) {
  if (!stored || typeof stored !== 'object') return false;
  return String(stored.person || '') === String(expected.person || '') &&
    String(stored.captureId || '') === String(expected.captureId || '');
}

function sameResearchReceipt_(meta, requestedBy, target, requestFingerprint) {
  if (!meta || meta.type !== 'research_instruction') return false;
  if (String(meta.capturer || '') !== String(requestedBy || '')) return false;
  var instruction = meta.researchInstruction;
  if (!instruction || String(instruction.requestedBy || '') !== String(requestedBy || '')) return false;
  if (!sameResearchTarget_(instruction.target, target)) return false;
  var storedFingerprint = String(meta.researchRequestFingerprint || instruction.requestFingerprint || '');
  return Boolean(storedFingerprint) && storedFingerprint === String(requestFingerprint || '');
}

function researchEnvelope_(requestValue, requestedBy, target, receiptId) {
  var request = normalizeResearchRequest_(requestValue) || { raw: '', mode: 'standard', purposes: [], focusIds: [], requestId: '' };
  var deep = request.mode === 'deep_evidence_graph';
  /* 계약 flowchart: `빠른 조사`는 `public-research-v1`의 **quick budget**으로 간다. 정책 자체는
     standard와 같은 판이고 예산만 좁다 — 사용자가 고른 것은 "기다리는 시간이 가장 짧은 것"이지
     "권한이 다른 조사"가 아니다. 계약이 숫자를 정하지 않으므로 서버가 정한다: standard의 약 3분의
     1로 두어 세 깊이의 순서(quick < standard < deep)가 예산에서도 그대로 보이게 한다. */
  var quick = request.mode === 'quick';
  return {
    raw: request.raw,
    mode: request.mode,
    purposes: request.purposes,
    focusIds: request.focusIds,
    requestId: request.requestId,
    requestFingerprint: researchRequestFingerprint_(request),
    sourceAuthority: 'public_lawful_only',
    requestedBy: String(requestedBy || '').slice(0, 120),
    requestedAt: new Date().toISOString(),
    target: target,
    receiptId: String(receiptId || '').slice(0, 80),
    status: 'received',
    policy: {
      version: deep ? 'lawful-authority-deep-research-v2' : 'public-research-v1',
      mode: deep ? 'evidence_graph_required' : 'bounded_plan_required',
      branchCap: deep ? 24 : quick ? 4 : 10,
      timeCapMinutes: deep ? 90 : quick ? 10 : 30,
      publicLawfulSourcesOnly: true,
      privateOrLoginSources: false,
      credentials: false,
      sensitiveTraitInference: false,
      doxxing: false,
      externalSendOrWrite: false,
      paidApi: false,
      protectedWriteOverride: false,
      humanGateOverride: false,
      reviewCeiling: 'agent_checked'
    }
  };
}

var RESEARCH_PROGRESS_PHASES_ = ['planning', 'branching', 'triangulating', 'synthesizing', 'done'];
var RESEARCH_CLAIM_STATES_ = ['fact', 'conflict', 'unknown', 'hypothesis'];
var RESEARCH_CONFIDENCE_ = ['low', 'medium', 'high'];
var RESEARCH_STOP_REASONS_ = ['purpose_satisfied', 'source_exhausted', 'irrelevant_branch', 'time_cap', 'branch_cap'];
var RESEARCH_NODE_TYPES_ = ['person', 'organization', 'project', 'event', 'claim', 'source'];
var RESEARCH_EDGE_RELATIONS_ = [
  'supports', 'counterevidence', 'affiliated_with', 'leads', 'member_of',
  'worked_on', 'participated_in', 'occurred_at', 'involves', 'related_to'
];
var DEEP_RESEARCH_BRANCH_CAP_ = 24;
var DEEP_RESEARCH_SOURCE_CAP_ = 144;
var DEEP_RESEARCH_TIME_CAP_MINUTES_ = 90;

/* research result는 사용자 입력 보정이 아니라 processor output 검증이다. 잘라서 유효하게
   꾸미지 않고 type·길이·control-character를 하나라도 어기면 graph 전체를 거절한다. */
function safeText_(value, maxLength) {
  if (typeof value !== 'string') return '';
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return '';
  var trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : '';
}

function safeIsoTimestamp_(value) {
  var text = safeText_(value, 40);
  return text && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) && isFinite(Date.parse(text)) ? text : '';
}

function safeCount_(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 && value <= 1000000 && Math.floor(value) === value ? value : null;
}

/* 목록에는 처리기가 실제로 쓴 checkpoint만 내보낸다. 일부 필드만 맞는 객체를 진행 상태로
   가장하지 않도록 여섯 필드를 모두 검증하고, 알려진 key만 새 객체로 복사한다. */
function validateResearchProgress_(value) {
  if (!value || typeof value !== 'object') return null;
  var phase = String(value.phase || '');
  var updatedAt = safeIsoTimestamp_(value.updatedAt);
  var verifiedFacts = safeCount_(value.verifiedFacts);
  var conflicts = safeCount_(value.conflicts);
  var openQuestions = safeCount_(value.openQuestions);
  var branchCount = safeCount_(value.branchCount);
  var sourceCount = safeCount_(value.sourceCount);
  var elapsedMinutes = typeof value.elapsedMinutes === 'number' && isFinite(value.elapsedMinutes) && value.elapsedMinutes >= 0
    ? value.elapsedMinutes : null;
  if (RESEARCH_PROGRESS_PHASES_.indexOf(phase) < 0 || typeof value.partial !== 'boolean' || !updatedAt ||
      verifiedFacts === null || conflicts === null || openQuestions === null || branchCount === null ||
      sourceCount === null || elapsedMinutes === null || branchCount > DEEP_RESEARCH_BRANCH_CAP_ ||
      sourceCount > DEEP_RESEARCH_SOURCE_CAP_ || elapsedMinutes > DEEP_RESEARCH_TIME_CAP_MINUTES_) return null;
  if ((phase === 'done' && value.partial) || (phase !== 'done' && !value.partial)) return null;
  if (value.partial && (branchCount >= DEEP_RESEARCH_BRANCH_CAP_ || elapsedMinutes >= DEEP_RESEARCH_TIME_CAP_MINUTES_)) return null;
  return {
    phase: phase,
    partial: value.partial,
    updatedAt: updatedAt,
    verifiedFacts: verifiedFacts,
    conflicts: conflicts,
    openQuestions: openQuestions,
    branchCount: branchCount,
    sourceCount: sourceCount,
    elapsedMinutes: elapsedMinutes
  };
}

function safeResearchUrl_(value) {
  var url = safeText_(value, 2048);
  if (!url || /[\\\s]/.test(url) || !/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[\/?#][^\s]*)?$/i.test(url)) return '';
  if (/^https?:\/\/[^\/?#]*@/i.test(url)) return '';
  var portMatch = url.match(/^https?:\/\/[A-Za-z0-9.-]+:(\d{1,5})(?:[\/?#]|$)/i);
  if (portMatch && parseInt(portMatch[1], 10) > 65535) return '';
  return url;
}

function safeResearchGraphId_(value) {
  var id = safeText_(value, 80);
  return id && /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/.test(id) ? id : '';
}

function validateResearchNode_(value, nodeById) {
  if (!value || typeof value !== 'object') return null;
  var id = safeResearchGraphId_(value.id);
  var type = String(value.type || '');
  var label = safeText_(value.label, 500);
  if (!id || nodeById[id] || RESEARCH_NODE_TYPES_.indexOf(type) < 0 || !label) return null;
  var url = '';
  if (value.url !== undefined) {
    url = safeResearchUrl_(value.url);
    if (!url) return null;
  }
  if (type === 'source' && !url) return null;
  var node = { id: id, type: type, label: label };
  if (url) node.url = url;
  nodeById[id] = node;
  return node;
}

function validateResearchEvidenceLink_(value, nodeById) {
  if (!value || typeof value !== 'object') return null;
  var sourceId = safeResearchGraphId_(value.sourceId);
  var title = safeText_(value.title, 500);
  var url = safeResearchUrl_(value.url);
  var sourceNode = sourceId ? nodeById[sourceId] : null;
  if (!sourceId || !title || !url || !sourceNode || sourceNode.type !== 'source' ||
      sourceNode.label !== title || sourceNode.url !== url) return null;
  var result = { sourceId: sourceId, title: title, url: url };
  if (value.publishedAt !== undefined) {
    var publishedAt = safeText_(value.publishedAt, 40);
    if (!publishedAt) return null;
    result.publishedAt = publishedAt;
  }
  return result;
}

function validateResearchEvidenceArray_(value, nodeById, claimId, relation, expectedEvidenceEdges) {
  if (!Array.isArray(value) || value.length > 100) return null;
  var result = [];
  for (var i = 0; i < value.length; i++) {
    var evidence = validateResearchEvidenceLink_(value[i], nodeById);
    if (!evidence) return null;
    var key = evidence.sourceId + '\n' + claimId + '\n' + relation;
    if (expectedEvidenceEdges[key]) return null;
    expectedEvidenceEdges[key] = true;
    result.push(evidence);
  }
  return result;
}

function validateResearchClaim_(value, seenIds, nodeById, expectedEvidenceEdges) {
  if (!value || typeof value !== 'object') return null;
  var id = safeResearchGraphId_(value.id);
  var state = String(value.state || '');
  var summary = safeText_(value.summary, 2000);
  var claimNode = id ? nodeById[id] : null;
  if (!id || seenIds[id] || !claimNode || claimNode.type !== 'claim' || claimNode.label !== summary ||
      RESEARCH_CLAIM_STATES_.indexOf(state) < 0 || !summary) return null;
  var evidenceFor = validateResearchEvidenceArray_(value.evidenceFor, nodeById, id, 'supports', expectedEvidenceEdges);
  var evidenceAgainst = validateResearchEvidenceArray_(value.evidenceAgainst, nodeById, id, 'counterevidence', expectedEvidenceEdges);
  if (!evidenceFor || !evidenceAgainst) return null;
  var confidence = value.confidence === undefined ? '' : String(value.confidence);
  if (confidence && RESEARCH_CONFIDENCE_.indexOf(confidence) < 0) return null;
  var alternative = value.alternativeExplanation === undefined ? '' : safeText_(value.alternativeExplanation, 2000);
  if (value.alternativeExplanation !== undefined && !alternative) return null;
  if (state === 'fact' && !evidenceFor.length) return null;
  if (state === 'conflict' && (!evidenceFor.length || !evidenceAgainst.length)) return null;
  if (state === 'hypothesis' && (!evidenceFor.length || !evidenceAgainst.length || !alternative || !confidence)) return null;
  seenIds[id] = true;
  var result = {
    id: id,
    state: state,
    summary: summary,
    evidenceFor: evidenceFor,
    evidenceAgainst: evidenceAgainst
  };
  if (confidence) result.confidence = confidence;
  if (alternative) result.alternativeExplanation = alternative;
  return result;
}

function validateResearchEdge_(value, nodeById, seenEdgeIds, seenEdgeTuples, expectedEvidenceEdges, matchedEvidenceEdges) {
  if (!value || typeof value !== 'object') return null;
  var id = safeResearchGraphId_(value.id);
  var sourceId = safeResearchGraphId_(value.sourceId);
  var targetId = safeResearchGraphId_(value.targetId);
  var relation = String(value.relation || '');
  var label = safeText_(value.label, 200);
  var source = sourceId ? nodeById[sourceId] : null;
  var target = targetId ? nodeById[targetId] : null;
  var tuple = sourceId + '\n' + targetId + '\n' + relation;
  if (!id || seenEdgeIds[id] || !source || !target || sourceId === targetId ||
      RESEARCH_EDGE_RELATIONS_.indexOf(relation) < 0 || !label || seenEdgeTuples[tuple]) return null;
  var evidenceRelation = relation === 'supports' || relation === 'counterevidence';
  if (evidenceRelation) {
    if (source.type !== 'source' || target.type !== 'claim' || !expectedEvidenceEdges[tuple] || matchedEvidenceEdges[tuple]) return null;
    matchedEvidenceEdges[tuple] = true;
  } else if (source.type === 'source' && target.type === 'claim') {
    return null;
  }
  seenEdgeIds[id] = true;
  seenEdgeTuples[tuple] = true;
  return { id: id, sourceId: sourceId, targetId: targetId, relation: relation, label: label };
}

/* `research-result.json`은 브라우저에 그대로 보내지 않는다. 전체 graph가 계약을 통과할 때만
   known-safe schema로 재구성해 publish한다. 하나라도 malformed면 결과 전체를 숨긴다. */
function validateResearchEvidenceGraph_(value) {
  if (!value || typeof value !== 'object' || value.version !== 'deep-research-evidence-v1') return null;
  if (!Array.isArray(value.purposes) || !value.purposes.length || value.purposes.length > RESEARCH_PURPOSES_.length) return null;
  var purposes = allowedStrings_(value.purposes, RESEARCH_PURPOSES_);
  if (purposes.length !== value.purposes.length) return null;
  if (!Array.isArray(value.claims) || value.claims.length > 200 ||
      !Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 500 ||
      !Array.isArray(value.edges) || value.edges.length > 1000 ||
      !Array.isArray(value.timeline) || value.timeline.length > 500 ||
      !Array.isArray(value.openQuestions) || value.openQuestions.length > 100) return null;

  var nodeById = {};
  var nodes = [];
  var sourceNodeCount = 0;
  for (var n = 0; n < value.nodes.length; n++) {
    var node = validateResearchNode_(value.nodes[n], nodeById);
    if (!node) return null;
    if (node.type === 'source') sourceNodeCount++;
    nodes.push(node);
  }

  var seenIds = {};
  var expectedEvidenceEdges = {};
  var claims = [];
  for (var i = 0; i < value.claims.length; i++) {
    var claim = validateResearchClaim_(value.claims[i], seenIds, nodeById, expectedEvidenceEdges);
    if (!claim) return null;
    claims.push(claim);
  }
  for (var nodeId in nodeById) {
    if (Object.prototype.hasOwnProperty.call(nodeById, nodeId) && nodeById[nodeId].type === 'claim' && !seenIds[nodeId]) return null;
  }

  var seenEdgeIds = {};
  var seenEdgeTuples = {};
  var matchedEvidenceEdges = {};
  var edges = [];
  for (var e = 0; e < value.edges.length; e++) {
    var edge = validateResearchEdge_(value.edges[e], nodeById, seenEdgeIds, seenEdgeTuples, expectedEvidenceEdges, matchedEvidenceEdges);
    if (!edge) return null;
    edges.push(edge);
  }
  for (var expectedEdge in expectedEvidenceEdges) {
    if (Object.prototype.hasOwnProperty.call(expectedEvidenceEdges, expectedEdge) && !matchedEvidenceEdges[expectedEdge]) return null;
  }

  var timeline = [];
  for (var t = 0; t < value.timeline.length; t++) {
    var event = value.timeline[t];
    if (!event || typeof event !== 'object') return null;
    var date = safeText_(event.date, 40);
    var label = safeText_(event.label, 1000);
    if (!date || !label || !Array.isArray(event.claimIds) || event.claimIds.length > 200) return null;
    var claimIds = [];
    for (var c = 0; c < event.claimIds.length; c++) {
      var claimId = safeText_(event.claimIds[c], 80);
      if (!claimId || !seenIds[claimId] || claimIds.indexOf(claimId) >= 0) return null;
      claimIds.push(claimId);
    }
    timeline.push({ date: date, label: label, claimIds: claimIds });
  }

  var openQuestions = [];
  for (var q = 0; q < value.openQuestions.length; q++) {
    var question = safeText_(value.openQuestions[q], 1000);
    if (!question || openQuestions.indexOf(question) >= 0) return null;
    openQuestions.push(question);
  }
  if (!value.stop || typeof value.stop !== 'object' || RESEARCH_STOP_REASONS_.indexOf(String(value.stop.reason || '')) < 0) return null;
  var stopSummary = safeText_(value.stop.summary, 2000);
  if (!stopSummary) return null;
  if (!value.metrics || typeof value.metrics !== 'object') return null;
  var metricBranches = safeCount_(value.metrics.branchCount);
  var metricSources = safeCount_(value.metrics.sourceCount);
  var metricMinutes = typeof value.metrics.elapsedMinutes === 'number' && isFinite(value.metrics.elapsedMinutes) && value.metrics.elapsedMinutes >= 0
    ? value.metrics.elapsedMinutes : null;
  if (metricBranches === null || metricSources === null || metricMinutes === null ||
      metricBranches > DEEP_RESEARCH_BRANCH_CAP_ || metricSources > DEEP_RESEARCH_SOURCE_CAP_ ||
      metricMinutes > DEEP_RESEARCH_TIME_CAP_MINUTES_ || metricSources < sourceNodeCount) return null;
  var stopReason = String(value.stop.reason);
  var atBranchCap = metricBranches >= DEEP_RESEARCH_BRANCH_CAP_;
  var atTimeCap = metricMinutes >= DEEP_RESEARCH_TIME_CAP_MINUTES_;
  if ((stopReason === 'branch_cap' && !atBranchCap) || (stopReason === 'time_cap' && !atTimeCap)) return null;
  if (atBranchCap && !atTimeCap && stopReason !== 'branch_cap') return null;
  if (atTimeCap && !atBranchCap && stopReason !== 'time_cap') return null;
  if (atBranchCap && atTimeCap && ['branch_cap', 'time_cap'].indexOf(stopReason) < 0) return null;
  return {
    version: 'deep-research-evidence-v1',
    purposes: purposes,
    nodes: nodes,
    edges: edges,
    claims: claims,
    timeline: timeline,
    openQuestions: openQuestions,
    metrics: { branchCount: metricBranches, sourceCount: metricSources, elapsedMinutes: metricMinutes },
    stop: { reason: stopReason, summary: stopSummary }
  };
}

function sameStringArray_(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (var i = 0; i < left.length; i++) if (String(left[i]) !== String(right[i])) return false;
  return true;
}

function upsertFile_(folder, fname, blob) {
  var it = folder.getFilesByName(fname);
  while (it.hasNext()) it.next().setTrashed(true);
  folder.createFile(blob);
}

/* 업로드 내용 지문 (FI-010).
   같은 촬영을 다시 보낸 것인지, 내용이 실제로 달라진 재업로드인지 구분하는 유일한 근거다.
   이미지 바이트 전체를 해시하지 않고 이름·길이만 쓴다 — Apps Script에서 수 MB를 해시하면
   업로드마다 초 단위 비용이 붙는다. 이름+길이+맥락이 모두 같은 다른 사진은 실무상 없다. */
function uploadFingerprint_(req, images) {
  var parts = [];
  for (var i = 0; i < images.length; i++) {
    var img = images[i] || {};
    var data = String(img.dataB64 || '');
    parts.push((captureSlotName_(img.name) || ('image' + i)) + ':' + data.length);
  }
  parts.sort();
  return [
    parts.join('|'),
    String(req.capturedAt || ''),
    String(req.event || '').slice(0, 200),
    String(req.note || '').slice(0, 2000)
  ].join('#');
}

/* 이미 저장된 캡처와 같은 업로드인가 (FI-010).

   지문(`uploadFingerprint`)이 있으면 그것으로 판정한다. 없으면 **지문 도입 이전에 접수된
   캡처**다 — 배포 시점의 모든 운영 캡처가 여기에 해당하므로 이 경로가 없으면 첫날부터
   보호가 없다. 그때는 저장된 메타로 비교할 수 있는 것(촬영 시각·만난 곳·메모·파일 이름)만
   비교한다. blind 재전송은 이 네 가지를 똑같이 재현하므로 잡힌다.

   한계: 지문 이전 캡처는 이미지 바이트 길이를 저장하지 않아, 같은 면을 다시 찍어 올리면서
   맥락을 하나도 바꾸지 않은 경우는 구분할 수 없다. 처리가 끝난 캡처의 다시 찍기는 클라이언트
   경로에 없고(수정은 correction), 앞으로 접수되는 캡처는 지문으로 정확히 판정된다. */
function sameAsStoredUpload_(prior, req, images, fingerprint) {
  if (!prior) return false;
  if (prior.uploadFingerprint) return prior.uploadFingerprint === fingerprint;
  if (String(prior.capturedAt || '') !== String(req.capturedAt || '')) return false;
  if (String(prior.event || '') !== String(req.event || '').slice(0, 200)) return false;
  if (String(prior.note || '') !== String(req.note || '').slice(0, 2000)) return false;
  var priorFiles = (prior.files || []).slice().sort().join('|');
  if (!priorFiles) return false;
  var names = [];
  for (var i = 0; i < images.length; i++) {
    names.push(captureSlotName_(images[i].name) || ('image' + i + '.jpg'));
  }
  return priorFiles === names.sort().join('|');
}

/* 처리가 이미 끝난 상태인가 (FI-015).
   requeue_와 같은 판정을 쓴다 — receivedAt이 processedAt보다 새로우면 아직 처리 대기다. */
function isTerminalMeta_(meta) {
  if (!meta) return false;
  var receivedMs = Date.parse(String(meta.receivedAt || ''));
  var processedMs = Date.parse(String(meta.processedAt || ''));
  var hasNewerReceipt = isFinite(receivedMs) && isFinite(processedMs) && receivedMs > processedMs;
  return (isFinite(processedMs) && (!isFinite(receivedMs) || processedMs >= receivedMs)) ||
    (!hasNewerReceipt && (meta.status === 'processed' || meta.status === 'skipped'));
}

function newId_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd-HHmmss') + '-' +
    Utilities.getUuid().slice(0, 4);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
