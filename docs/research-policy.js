(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardCaptureResearch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_LENGTH = 2000;
  var POLICY_VERSION = 'public-research-v1';
  var RISK_PATTERNS = [
    { id: 'prompt_injection', re: /(ignore|무시).{0,24}(instruction|지시|규칙)|system\s*prompt|시스템\s*프롬프트/i },
    { id: 'private_source', re: /비공개|private|로그인|login|DM|쪽지|사내\s*(자료|메일)|closed\s*group/i },
    { id: 'credential', re: /credential|password|비밀번호|토큰|token|cookie|세션/i },
    { id: 'sensitive_inference', re: /정치성향|종교|성적\s*지향|건강|질병|인종|민감\s*특성/i },
    { id: 'doxxing', re: /집주소|가족\s*주소|신상\s*털|doxx|동선\s*추적/i },
    { id: 'external_effect', re: /(이?메일|문자).{0,8}보내|게시|업로드|파일\s*수정|write|send/i },
    { id: 'paid_effect', re: /유료\s*API|결제|구매|paid\s*api|subscribe/i },
    { id: 'protected_write', re: /human_validated|AGENTS\.md|schema|스키마|allowlist|허용\s*경로/i }
  ];

  function sanitizeRaw(value) {
    return String(value || '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, MAX_LENGTH);
  }

  function riskFlags(raw) {
    var text = sanitizeRaw(raw);
    return RISK_PATTERNS.filter(function (item) { return item.re.test(text); })
      .map(function (item) { return item.id; });
  }

  function buildSubmission(value) {
    var raw = sanitizeRaw(value);
    if (!raw) return null;
    return {
      raw: raw,
      channel: 'owner_ui',
      policyVersion: POLICY_VERSION,
      riskFlags: riskFlags(raw)
    };
  }

  /* The raw request is deliberately referenced, never concatenated into policy text. */
  function boundedPlanTemplate() {
    return {
      policyVersion: POLICY_VERSION,
      requestedFocusRef: 'researchInstruction.raw',
      mode: 'public_professional_background',
      steps: [
        'resolve_identity_from_business_card_and_existing_person',
        'search_public_lawful_sources',
        'cross_check_material_claims',
        'report_sources_confidence_and_unknowns'
      ],
      constraints: {
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

  return {
    MAX_LENGTH: MAX_LENGTH,
    POLICY_VERSION: POLICY_VERSION,
    sanitizeRaw: sanitizeRaw,
    riskFlags: riskFlags,
    buildSubmission: buildSubmission,
    boundedPlanTemplate: boundedPlanTemplate
  };
});
