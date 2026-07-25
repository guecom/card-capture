import { useMemo } from 'react';
import { parseMarkdownBlocks } from '../services/markdown';

// legacy mdLite와 같은 경량 마크다운 뷰: 제목·불릿·구분선·화살표·표(escaped pipe 포함).
export function MarkdownLite({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="md-lite">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'table':
            return (
              <div className="md-table-wrap" key={index}>
                <table>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => rowIndex === 0
                          ? <th key={cellIndex}>{cell}</th>
                          : <td key={cellIndex}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'h1':
            return <div className="md-h1" key={index}>{block.text}</div>;
          case 'h2':
            return <div className="md-h2" key={index}>{block.text}</div>;
          case 'h3':
            return <div className="md-h3" key={index}>{block.text}</div>;
          case 'bullet':
            return <div className="md-bullet" key={index}>• {block.text}</div>;
          case 'hr':
            return <div className="md-hr" key={index} />;
          case 'arrow':
            return <div className="md-arrow" key={index}>{block.text}</div>;
          case 'blank':
            return <div className="md-blank" key={index} />;
          default:
            return <div className="md-p" key={index}>{block.text}</div>;
        }
      })}
    </div>
  );
}
