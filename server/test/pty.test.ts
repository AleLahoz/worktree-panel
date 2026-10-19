import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyManager, type PtyClient, type RawPty, type ServerMessage } from "../src/services/PtyManager.js";

class FakePty implements RawPty {
  pid = 1;
  written: string[] = [];
  killed = false;
  resizes: [number, number][] = [];
  private dataCb: (d: string) => void = () => {};
  private exitCb: (e: { exitCode: number }) => void = () => {};
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.resizes.push([c, r]); }
  kill() { this.killed = true; setTimeout(() => this.exit(0), 5); }
  emit(d: string) { this.dataCb(d); }
  exit(code = 0) { this.exitCb({ exitCode: code }); }
}

const recorder = () => {
  const msgs: ServerMessage[] = [];
  const client: PtyClient = { send: (m) => void msgs.push(m) };
  const out = () => msgs.filter((m) => m.t === "out").map((m) => (m as { d: string }).d).join("");
  return { msgs, client, out };
};

let mgr: PtyManager | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await mgr?.killAll();
  mgr = undefined;
});

function setup(opts: ConstructorParameters<typeof PtyManager>[0] = {}) {
  const fake = new FakePty();
  mgr = new PtyManager({ spawn: () => fake, ...opts });
  const pty = mgr.spawn("t1", "claude", { file: "x", args: [], cwd: "." });
  return { fake, pty, mgr };
}

describe("PtyManager", () => {
  it("reenvía el buffer a un cliente nuevo y luego la salida en vivo", async () => {
    vi.useFakeTimers();
    const { fake, pty } = setup();
    fake.emit("hola ");
    const a = recorder();
    pty.attach(a.client);
    expect(a.out()).toBe("hola ");
    fake.emit("mundo");
    await vi.advanceTimersByTimeAsync(20);
    expect(a.out()).toBe("hola mundo");
  });

  it("agrupa la salida en lotes (un mensaje por tick, no uno por trozo)", async () => {
    vi.useFakeTimers();
    const { fake, pty } = setup();
    const a = recorder();
    pty.attach(a.client);
    for (let i = 0; i < 50; i++) fake.emit("x");
    await vi.advanceTimersByTimeAsync(20);
    const outs = a.msgs.filter((m) => m.t === "out");
    expect(outs).toHaveLength(1);
    expect((outs[0] as { d: string }).d).toBe("x".repeat(50));
  });

  it("buffer circular: descarta lo más antiguo al superar el límite", () => {
    const { fake, pty } = setup({ bufferChars: 10 });
    fake.emit("0123456789");
    fake.emit("ABCDE");
    const a = recorder();
    pty.attach(a.client);
    expect(a.out()).toBe("ABCDE");
    fake.emit("x".repeat(25)); // un solo trozo mayor que el límite
    const b = recorder();
    pty.attach(b.client);
    expect(b.out()).toBe("x".repeat(10));
  });

  it("varios clientes ven la misma salida y un cliente que falla se descarta", async () => {
    vi.useFakeTimers();
    const { fake, pty } = setup();
    const a = recorder();
    const b = recorder();
    pty.attach(a.client);
    pty.attach(b.client);
    pty.attach({ send: (m) => { if (m.t === "out") throw new Error("socket cerrado"); } });
    fake.emit("hi");
    await vi.advanceTimersByTimeAsync(20);
    expect(a.out()).toBe("hi");
    expect(b.out()).toBe("hi");
  });

  it("estado: running -> waiting tras 3 s sin salida -> running con salida -> stopped al salir", async () => {
    let t = 1000;
    const { fake, pty } = setup({ now: () => t });
    const a = recorder();
    pty.attach(a.client);
    const statuses = () => a.msgs.filter((m) => m.t === "status").map((m) => (m as { s: string }).s);
    expect(pty.status()).toBe("running");
    t += 3001;
    expect(pty.status()).toBe("waiting");
    pty.refreshStatus();
    fake.emit("salida");
    t += 100;
    expect(pty.status()).toBe("running");
    fake.exit(0);
    expect(pty.status()).toBe("stopped");
    expect(statuses()).toEqual(["running", "waiting", "running", "stopped"]);
  });

  it("write/resize tras el exit se ignoran sin lanzar (node-pty tumbaría el proceso)", () => {
    const { fake, pty } = setup();
    fake.exit(1);
    expect(pty.write("x")).toBe(false);
    expect(() => pty.resize(100, 40)).not.toThrow();
    expect(fake.written).toEqual([]);
    expect(fake.resizes).toEqual([]);
    expect(pty.exitCode).toBe(1);
  });

  it("un cliente que se conecta tras terminar recibe buffer, exit y estado", () => {
    const { fake, pty } = setup();
    fake.emit("fin");
    fake.exit(3);
    const a = recorder();
    pty.attach(a.client);
    expect(a.msgs).toEqual([{ t: "out", d: "fin" }, { t: "exit", code: 3 }, { t: "status", s: "stopped" }]);
  });

  it("no permite dos ptys vivas del mismo tipo, pero sí tras terminar la anterior", () => {
    const made: FakePty[] = [];
    const m = new PtyManager({ spawn: () => { const f = new FakePty(); made.push(f); return f; } });
    mgr = m;
    const opts = { file: "x", args: [], cwd: "." };
    m.spawn("t1", "claude", opts);
    expect(() => m.spawn("t1", "claude", opts)).toThrow(/viva/);
    expect(() => m.spawn("t1", "shell", opts)).not.toThrow();
    made[0].exit(0);
    expect(() => m.spawn("t1", "claude", opts)).not.toThrow();
  });

  it("killTask mata y espera a que terminen", async () => {
    const { fake, mgr } = setup();
    await mgr.killTask("t1");
    expect(fake.killed).toBe(true);
    expect(mgr.isAlive("t1", "claude")).toBe(false);
  });

  it("ignora resize inválido", () => {
    const { fake, pty } = setup();
    pty.resize(0, 10);
    expect(fake.resizes).toEqual([]);
    pty.resize(90, 20);
    expect(fake.resizes).toEqual([[90, 20]]);
  });
});

describe("node-pty real (ConPTY en Windows)", () => {
  it("ejecuta un proceso, entrega su salida y detecta la salida", async () => {
    mgr = new PtyManager();
    const pty = mgr.spawn("real", "shell", {
      file: process.execPath,
      args: ["-e", "process.stdin.once('data', d => { console.log('eco:' + String(d).trim()); process.exit(7); });console.log('listo')"],
      cwd: process.cwd(),
    });
    const a = recorder();
    pty.attach(a.client);
    await vi.waitFor(() => expect(a.out()).toContain("listo"), { timeout: 10000 });
    pty.write("ping\r");
    expect(await pty.waitForExit(10000)).toBe(true);
    expect(a.out()).toContain("eco:ping");
    expect(pty.exitCode).toBe(7);
    expect(() => pty.write("tarde")).not.toThrow();
  });
});
