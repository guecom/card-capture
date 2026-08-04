// 연결이 없을 때 붙는 **inline setup card** (TSK-000545 / INT-000030 / DEC-000105).
//
// 이 컴포넌트가 대체하는 것은 화면 맨 위의 `링크 설정이 필요해요` 전면 경고다. 그 경고는
// `role="alert"`로 낭독기를 가로채고, 무엇이 막혔는지 말하지 않았으며, 누를 것이 하나도 없었다.
// 무엇보다 **멀쩡히 되는 일 위에** 떠서 앱 전체가 고장 난 것처럼 보이게 했다.
//
// 그래서 이 카드는 반대로 만든다:
//   - 실제로 막힌 기능(서버 전송·사람 찾기) **옆**에만 붙는다. 화면 맨 위가 아니다.
//   - `role="status"` — 알려 주되 가로채지 않는다. 되던 것이 끊긴 상태(`warn`)에서도 껍데기는 산다.
//   - 손잡이는 **하나**다. 고르게 하면 그것이 또 하나의 설정이 된다.
import '../styles/int30-desktop.css';
import { CircleAlert, Link2 } from 'lucide-react';
import type { ConnectionSetupPrompt } from '../services/bootstrap-gate';

export interface ConnectionSetupCardProps {
  prompt: ConnectionSetupPrompt;
  /** 단 한 번의 guided action. 앱 안의 연결 설정으로 데려간다 — URL로 코드를 받지 않는다. */
  onAction(): void;
  /** 어떤 기능 옆에 붙었는지. 낭독기가 그 관계를 읽는다. */
  anchorLabel?: string;
}

export function ConnectionSetupCard({ prompt, onAction, anchorLabel }: ConnectionSetupCardProps) {
  const Icon = prompt.tone === 'warn' ? CircleAlert : Link2;
  return (
    <section
      className="cc-setup-card"
      data-tone={prompt.tone}
      data-situation={prompt.situation}
      role="status"
      aria-label={anchorLabel ? `${anchorLabel} 연결 안내` : '연결 안내'}
    >
      <span className="cc-setup-icon" aria-hidden="true"><Icon size={17} /></span>
      <div className="cc-setup-copy">
        <strong>{prompt.title}</strong>
        <p>{prompt.body}</p>
      </div>
      <button className="cc-setup-action" type="button" onClick={onAction}>{prompt.actionLabel}</button>
    </section>
  );
}
