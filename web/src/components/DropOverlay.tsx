export function DropOverlay({ taskKey }: { taskKey: string }) {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-box">
        Suelta para añadir a <span className="mono">.task/</span> de <span className="mono">{taskKey}</span>
      </div>
    </div>
  );
}
