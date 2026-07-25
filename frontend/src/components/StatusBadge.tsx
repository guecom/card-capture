import { Check, CircleAlert, Clock3, LoaderCircle } from 'lucide-react';
import type { ProcessingStatus } from '../contracts/capture';

interface Props {
  status: ProcessingStatus;
}

const copy: Record<string, string> = {
  received: '접수됨',
  processing: '처리 중',
  processed: '완료',
  skipped: '건너뜀',
};

export function StatusBadge({ status }: Props) {
  const Icon = status === 'processed' ? Check : status === 'skipped' ? CircleAlert : status === 'processing' ? LoaderCircle : Clock3;
  return (
    <span className={`status-badge status-${status}`}>
      <Icon aria-hidden="true" size={13} strokeWidth={2.2} />
      {copy[status] ?? status}
    </span>
  );
}
