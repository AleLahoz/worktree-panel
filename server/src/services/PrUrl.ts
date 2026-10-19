import { AppError } from "../errors.js";

export type Provider = "github" | "gitlab" | "bitbucket" | "azure";

/**
 * Convierte la URL de un remoto git en la URL web del repositorio, sin credenciales ni `.git`.
 *   git@github.com:org/repo.git            -> https://github.com/org/repo
 *   https://user:token@host/org/repo.git   -> https://host/org/repo
 *   git@ssh.dev.azure.com:v3/o/p/repo      -> https://dev.azure.com/o/p/_git/repo
 */
export function normalizeRemote(remote: string): { web: string; host: string } | null {
  const raw = remote.trim();
  // Rutas locales (C:\repo, /srv/repo, ./repo, \\servidor\repo, file://…) no tienen página web de PR.
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^(\/|\.\.?[\\/]|\\\\)/.test(raw) || /^file:/i.test(raw)) return null;
  let host: string;
  let repoPath: string;
  let port = "";

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!url.hostname) return null;
    host = url.hostname;
    repoPath = url.pathname;
    // El puerto de ssh:// y git:// no es el del sitio web; el de https sí.
    if (/^https?:$/.test(url.protocol) && url.port) port = `:${url.port}`;
  }

  repoPath = repoPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (!repoPath) return null;

  // Azure DevOps por SSH: v3/{org}/{project}/{repo}
  if (/(^|\.)ssh\.dev\.azure\.com$/i.test(host)) {
    const m = /^v3\/([^/]+)\/([^/]+)\/(.+)$/.exec(repoPath);
    if (!m) return null;
    return { host: "dev.azure.com", web: `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}` };
  }
  return { host, web: `https://${host}${port}/${repoPath}` };
}

export function detectProvider(host: string): Provider | null {
  const h = host.toLowerCase();
  if (h === "github.com") return "github";
  if (h === "bitbucket.org") return "bitbucket";
  if (h === "dev.azure.com" || h.endsWith(".visualstudio.com")) return "azure";
  if (h === "gitlab.com" || h.split(".").includes("gitlab") || h.startsWith("gitlab.")) return "gitlab";
  return null;
}

export interface PrUrlInput {
  remote: string;
  branch: string;
  base: string;
  /** Plantilla del repo con {web} {branch} {base}, solo si el proveedor no se reconoce. */
  template?: string;
}

/** URL para abrir un PR/MR de `branch` hacia `base` (el destino es la base de la tarea, no la principal del repo). */
export function buildPrUrl({ remote, branch, base, template }: PrUrlInput): { url: string; provider: Provider | "template" } {
  const norm = normalizeRemote(remote);
  if (!norm) {
    throw new AppError(422, "remote_unsupported", `El remoto origin (${remote}) no es la URL de un servidor git (GitHub, GitLab, Bitbucket, Azure DevOps…), así que no se puede construir la página del PR.`);
  }
  const b = encodeURIComponent(branch);
  const t = encodeURIComponent(base);
  const provider = detectProvider(norm.host);
  const { web } = norm;

  switch (provider) {
    case "github":
      return { provider, url: `${web}/compare/${t}...${b}?expand=1` };
    case "gitlab":
      return { provider, url: `${web}/-/merge_requests/new?merge_request[source_branch]=${b}&merge_request[target_branch]=${t}` };
    case "bitbucket":
      return { provider, url: `${web}/pull-requests/new?source=${b}&dest=${t}` };
    case "azure":
      return { provider, url: `${web}/pullrequestcreate?sourceRef=${b}&targetRef=${t}` };
  }
  if (template) {
    return { provider: "template", url: template.replaceAll("{web}", web).replaceAll("{branch}", b).replaceAll("{base}", t) };
  }
  throw new AppError(422, "provider_unknown", `No se reconoce el proveedor de ${norm.host}. Define una plantilla de URL de PR en los ajustes del repo.`, { host: norm.host });
}
