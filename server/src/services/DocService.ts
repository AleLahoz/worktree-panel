import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { AppError } from "../errors.js";
import type { Task } from "../types.js";

export const MAX_DOC_BYTES = 50 * 1024 * 1024;

/** Tipos que Claude Code lee bien. Otros se admiten, pero con aviso. */
export const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".json", ".csv", ".xml", ".html"]);

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface DocInfo {
  name: string;
  size: number;
  modified: string;
}

export interface SavedDoc extends DocInfo {
  /** Presente si el tipo de fichero puede no leerse bien en Claude Code. */
  warning?: string;
}

/** Quita separadores de ruta y caracteres no válidos en Windows; evita nombres reservados y vacíos. */
export function sanitizeName(input: string): string {
  let name = input.replace(/\\/g, "/").split("/").pop() ?? "";
  name = name.replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/[. ]+$/, "").trim();
  if (name.length > 150) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 150 - ext.length) + ext;
  }
  if (!name || name === "." || name === "..") name = "archivo";
  if (RESERVED.test(name)) name = `_${name}`;
  return name;
}

/** `nombre.ext` -> `nombre-2.ext`, `nombre-3.ext`… hasta encontrar uno libre. */
export function uniqueName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

export type Opener = (file: string) => Promise<void>;

const systemOpen: Opener = (file) =>
  new Promise((resolve, reject) => {
    const [cmd, args] =
      process.platform === "win32" ? ["explorer.exe", [file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
    // explorer.exe devuelve código 1 aunque abra bien el fichero: solo importa que se pueda lanzar.
    execFile(cmd, args, { windowsHide: false }, (err) => (err && (err as NodeJS.ErrnoException).code === "ENOENT" ? reject(err) : resolve()));
  });

/** Documentos de una tarea: viven en <worktree>/.task/ y nunca se suben a git. */
export class DocService {
  constructor(private opener: Opener = systemOpen) {}

  dir(task: Task): string {
    return path.join(task.worktreePath, ".task");
  }

  /** Ruta absoluta de un documento; rechaza nombres que escapen de .task/ (path traversal). */
  resolve(task: Task, name: string): string {
    const dir = path.resolve(this.dir(task));
    const target = path.resolve(dir, name);
    if (name !== path.basename(name) || name === "" || !target.startsWith(dir + path.sep)) {
      throw new AppError(400, "invalid_doc_name", "Nombre de documento no válido");
    }
    return target;
  }

  async list(task: Task): Promise<DocInfo[]> {
    let entries;
    try {
      entries = await readdir(this.dir(task), { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const docs = await Promise.all(
      entries.filter((e) => e.isFile()).map(async (e) => {
        const s = await stat(path.join(this.dir(task), e.name));
        return { name: e.name, size: s.size, modified: s.mtime.toISOString() };
      }),
    );
    return docs.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Guarda un fichero recibido como stream. Si supera el límite, borra lo escrito y falla. */
  async save(task: Task, originalName: string, stream: Readable & { truncated?: boolean }): Promise<SavedDoc> {
    const dir = this.dir(task);
    await mkdir(dir, { recursive: true });
    const existing = new Set((await readdir(dir)).map((n) => n.toLowerCase()));
    const name = uniqueName(sanitizeName(originalName), (n) => existing.has(n.toLowerCase()));
    const dest = this.resolve(task, name);
    try {
      await pipeline(stream, createWriteStream(dest, { flags: "wx" }));
    } catch (e) {
      await rm(dest, { force: true });
      throw e;
    }
    if (stream.truncated) {
      await rm(dest, { force: true });
      throw new AppError(413, "file_too_large", `${originalName} supera el máximo de 50 MB`);
    }
    const s = await stat(dest);
    const ext = path.extname(name).toLowerCase();
    return {
      name,
      size: s.size,
      modified: s.mtime.toISOString(),
      warning: SUPPORTED_EXTENSIONS.has(ext)
        ? undefined
        : `Claude Code puede no leer bien los ficheros ${ext || "sin extensión"}. Si es posible, exporta a PDF o Markdown.`,
    };
  }

  async remove(task: Task, name: string): Promise<void> {
    const target = this.resolve(task, name);
    if (!(await stat(target).then((s) => s.isFile(), () => false))) throw new AppError(404, "doc_not_found", `No existe el documento ${name}`);
    await rm(target);
  }

  /** Abre el documento con la aplicación predeterminada del sistema. */
  async open(task: Task, name: string): Promise<void> {
    const target = this.resolve(task, name);
    if (!(await stat(target).then((s) => s.isFile(), () => false))) throw new AppError(404, "doc_not_found", `No existe el documento ${name}`);
    await this.opener(target);
  }
}
