import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** Diálogo nativo: foco atrapado, Esc cierra y el fondo queda inerte. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    // showModal() enfoca el primer control (el botón de cerrar); el autoFocus de React corre antes de abrir.
    d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => d.close();
  }, []);
  return (
    <dialog ref={ref} className={wide ? "modal wide" : "modal"} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="modal-body">
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar"><X size={16} /></button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
