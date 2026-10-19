import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { buildPrUrl, detectProvider, normalizeRemote } from "../src/services/PrUrl.js";

describe("normalizeRemote", () => {
  const web = (r: string) => normalizeRemote(r)?.web;

  it("SSH estilo scp, con y sin .git", () => {
    expect(web("git@github.com:org/repo.git")).toBe("https://github.com/org/repo");
    expect(web("git@github.com:org/repo")).toBe("https://github.com/org/repo");
    expect(web("git@gitlab.example.com:group/sub/repo.git")).toBe("https://gitlab.example.com/group/sub/repo");
  });

  it("https: quita .git, barra final y credenciales", () => {
    expect(web("https://github.com/org/repo.git")).toBe("https://github.com/org/repo");
    expect(web("https://github.com/org/repo/")).toBe("https://github.com/org/repo");
    expect(web("https://user:s3cr3t@bitbucket.org/team/repo.git")).toBe("https://bitbucket.org/team/repo");
    expect(web("https://oauth2:ghp_abc123@github.com/org/repo.git")).toBe("https://github.com/org/repo");
    expect(web("https://x-access-token@github.com/org/repo")).toBe("https://github.com/org/repo");
  });

  it("nunca deja credenciales en la URL resultante", () => {
    const out = normalizeRemote("https://user:s3cr3t@host.example/org/repo.git")!.web;
    expect(out).not.toMatch(/s3cr3t|user|@/);
  });

  it("ssh:// descarta el puerto SSH; https conserva el suyo", () => {
    expect(web("ssh://git@gitlab.example.com:2222/group/repo.git")).toBe("https://gitlab.example.com/group/repo");
    expect(web("https://gitlab.example.com:8443/group/repo.git")).toBe("https://gitlab.example.com:8443/group/repo");
  });

  it("Azure DevOps por https y por SSH", () => {
    expect(web("https://myorg@dev.azure.com/myorg/Proj/_git/repo")).toBe("https://dev.azure.com/myorg/Proj/_git/repo");
    expect(web("git@ssh.dev.azure.com:v3/myorg/Proj/repo")).toBe("https://dev.azure.com/myorg/Proj/_git/repo");
    expect(web("https://myorg.visualstudio.com/Proj/_git/repo")).toBe("https://myorg.visualstudio.com/Proj/_git/repo");
  });

  it("rutas locales (Windows y POSIX) no son remotos web: no se confunden con scp", () => {
    expect(normalizeRemote("C:\\Users\\dev\\origin.git")).toBeNull();
    expect(normalizeRemote("D:/repos/origin.git")).toBeNull();
    expect(normalizeRemote("/srv/git/origin.git")).toBeNull();
    expect(normalizeRemote("../origin.git")).toBeNull();
    expect(normalizeRemote("\\\\servidor\\repos\\origin.git")).toBeNull();
    expect(normalizeRemote("file:///srv/git/origin.git")).toBeNull();
    expect(() => buildPrUrl({ remote: "C:\\x\\origin.git", branch: "b", base: "d" })).toThrowError(/no es la URL de un servidor git/);
  });

  it("devuelve null con basura", () => {
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("no es una url")).toBeNull();
    expect(normalizeRemote("https://github.com")).toBeNull();
  });
});

describe("detectProvider", () => {
  it("reconoce por host", () => {
    expect(detectProvider("github.com")).toBe("github");
    expect(detectProvider("gitlab.com")).toBe("gitlab");
    expect(detectProvider("gitlab.miempresa.com")).toBe("gitlab");
    expect(detectProvider("bitbucket.org")).toBe("bitbucket");
    expect(detectProvider("dev.azure.com")).toBe("azure");
    expect(detectProvider("miorg.visualstudio.com")).toBe("azure");
    expect(detectProvider("git.interno.example")).toBeNull();
  });
});

describe("buildPrUrl: el destino es la base de la tarea, no la principal del repo", () => {
  const input = { branch: "feature/PROJ-1", base: "develop" };

  it("GitHub", () => {
    expect(buildPrUrl({ ...input, remote: "git@github.com:org/repo.git" })).toEqual({
      provider: "github",
      url: "https://github.com/org/repo/compare/develop...feature%2FPROJ-1?expand=1",
    });
  });

  it("GitLab", () => {
    expect(buildPrUrl({ ...input, remote: "https://gitlab.com/g/r.git" }).url).toBe(
      "https://gitlab.com/g/r/-/merge_requests/new?merge_request[source_branch]=feature%2FPROJ-1&merge_request[target_branch]=develop",
    );
  });

  it("Bitbucket", () => {
    expect(buildPrUrl({ ...input, remote: "git@bitbucket.org:team/repo.git" }).url).toBe(
      "https://bitbucket.org/team/repo/pull-requests/new?source=feature%2FPROJ-1&dest=develop",
    );
  });

  it("Azure DevOps", () => {
    expect(buildPrUrl({ ...input, remote: "https://org@dev.azure.com/org/P/_git/r" }).url).toBe(
      "https://dev.azure.com/org/P/_git/r/pullrequestcreate?sourceRef=feature%2FPROJ-1&targetRef=develop",
    );
  });

  it("codifica ramas con caracteres especiales", () => {
    const { url } = buildPrUrl({ remote: "git@github.com:o/r.git", branch: "fix/a b&c#1", base: "release/1.0" });
    expect(url).toBe("https://github.com/o/r/compare/release%2F1.0...fix%2Fa%20b%26c%231?expand=1");
  });

  it("proveedor desconocido: usa la plantilla del repo, y si no hay, error explicativo", () => {
    const remote = "git@git.interno.example:team/repo.git";
    expect(buildPrUrl({ ...input, remote, template: "{web}/pr?from={branch}&to={base}" })).toEqual({
      provider: "template",
      url: "https://git.interno.example/team/repo/pr?from=feature%2FPROJ-1&to=develop",
    });
    try {
      buildPrUrl({ ...input, remote });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("provider_unknown");
    }
  });

  it("la plantilla no se usa si el proveedor se reconoce", () => {
    const { provider } = buildPrUrl({ ...input, remote: "git@github.com:o/r.git", template: "{web}/otra" });
    expect(provider).toBe("github");
  });
});
