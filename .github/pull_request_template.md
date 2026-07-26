## Summary

무엇을 왜 바꾸는지 설명한다.

## Related work

- GitHub Issue:
- Kairen-Ref: TSK-XXXXXX
- Product contract owner:
- Exact repository head:

## Merge decision

- Merge lane: `AUTO-MERGE OK` / `HUMAN TEST REQUIRED` / `MATERIAL APPROVAL REQUIRED`
- Independent reviewer / review context:
- Required check: `validate`
- Exact-head check run:
- Merge conflict: No / Yes
- Unresolved review conversations: 0 / count
- Acceptance evidence:
- Rollback:
- `docs/` live Pages surface change: No / Yes
- Human approval receipt or `not required`:

새 commit은 기록된 check와 review 결론을 무효화한다. Repository auto-merge는 모든 조건을 만족한 `AUTO-MERGE OK`에만 enable할 수 있다.

## Scope and impact

- Affected paths:
- User-visible / camera / OCR / device impact:
- Product contract / authority impact:
- Identity / credential / data / external send-write impact:
- Dependency / workflow / release / deploy impact:
- Out of scope:

## Validation

- Commands run:
- Results:
- Checks not run and why:

## Agent provenance

- Prepared by: Human / Codex / Claude Code / GitHub Copilot / Other
- Human review required: No / Test / Material approval

## Boundary checklist

- [ ] GitHub Issue가 problem과 acceptance를 소유한다.
- [ ] Kairen Task reference가 실제 ID와 일치한다.
- [ ] `validate`가 exact current head에서 PASS했다.
- [ ] secret, token, Drive folder ID, 실캡처 데이터와 Person 개인정보가 없다.
- [ ] 선택한 merge lane이 `docs/`, device UX, Product, authority, data, dependency/workflow, release와 external-effect 경계와 일치한다.
- [ ] rollback과 남은 human gate가 명시됐다.
- [ ] synthetic/internal result를 customer proof로 부르지 않는다.

MVP build/testability gate comes before customer proof.
