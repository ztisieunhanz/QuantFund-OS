import type {
  PermissionOutput,
  PermissionOutputProvenance,
  ProvenancedPermissionOutput,
  ProvenancedRiskOutput,
  ProvenancedSignalOutput,
  PointInTimeMacro,
  RiskOutput,
  RiskOutputProvenance,
  SignalOutput,
  SignalOutputProvenance,
} from "@/lib/quant/types";

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };

function normalizeCanonical(value: unknown, seen: WeakSet<object>): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Producer provenance rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeCanonical(item, seen));
  if (typeof value !== "object") throw new Error(`Unsupported producer provenance value: ${typeof value}`);
  if (seen.has(value)) throw new Error("Producer provenance rejects cyclic values");
  seen.add(value);
  const source = value as Readonly<Record<string, unknown>>;
  const normalized: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) normalized[key] = normalizeCanonical(source[key], seen);
  }
  seen.delete(value);
  return normalized;
}

export function canonicalProducerJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value, new WeakSet<object>()));
}

// Synchronous, browser-safe SHA-256. This intentionally avoids Node crypto so
// producer identities are identical in replay, browser and server runtimes.
function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const k = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

export function producerIdentity(value: unknown): string {
  return `sha256:${sha256Hex(canonicalProducerJson(value))}`;
}

export function immutableProducerCopy<T>(value: T): T {
  const copy = normalizeCanonical(value, new WeakSet<object>());
  const freeze = (item: CanonicalValue): CanonicalValue => {
    if (Array.isArray(item)) {
      item.forEach(freeze);
      return Object.freeze(item);
    }
    if (item !== null && typeof item === "object") {
      Object.values(item).forEach(freeze);
      return Object.freeze(item);
    }
    return item;
  };
  return freeze(copy) as T;
}

type SignalMaterial = Omit<SignalOutput, "provenance">;
type PermissionMaterial = Omit<PermissionOutput, "provenance">;
type RiskMaterial = Omit<RiskOutput, "provenance">;

function signalSemanticMaterial(signal: SignalMaterial, inputIdentity: string, configIdentity: string) {
  return { schemaVersion: "M14_A04_SIGNAL_PROVENANCE_V1", signal, inputIdentity, configIdentity };
}

export function createSignalOutput(
  signal: SignalMaterial,
  producerInputs: unknown,
  producerConfig: unknown,
): ProvenancedSignalOutput {
  const inputIdentity = producerIdentity(producerInputs);
  const configIdentity = producerIdentity(producerConfig);
  return immutableProducerCopy({ ...signal, provenance: {
    schemaVersion: "M14_A04_SIGNAL_PROVENANCE_V1" as const,
    producer: signal.strategyId,
    inputIdentity,
    configIdentity,
    semanticIdentity: producerIdentity(signalSemanticMaterial(signal, inputIdentity, configIdentity)),
  } });
}

export function validateSignalOutput(signal: SignalOutput, producerInputs?: unknown, producerConfig?: unknown): asserts signal is SignalOutput & { readonly provenance: SignalOutputProvenance } {
  const { provenance, ...material } = signal;
  if (!provenance) throw new Error("Signal provenance is required");
  if (provenance.schemaVersion !== "M14_A04_SIGNAL_PROVENANCE_V1" || provenance.producer !== signal.strategyId) throw new Error("Invalid signal provenance contract");
  if (producerInputs !== undefined && provenance.inputIdentity !== producerIdentity(producerInputs)) throw new Error("Signal input identity mismatch");
  if (producerConfig !== undefined && provenance.configIdentity !== producerIdentity(producerConfig)) throw new Error("Signal config identity mismatch");
  if (provenance.semanticIdentity !== producerIdentity(signalSemanticMaterial(material, provenance.inputIdentity, provenance.configIdentity))) throw new Error("Signal semantic identity mismatch");
}

function permissionSemanticMaterial(permission: PermissionMaterial, provenance: Omit<PermissionOutputProvenance, "semanticIdentity">) {
  return { ...provenance, permission };
}

export function createPermissionOutput(permission: PermissionMaterial, decisionTime: number, macro: PointInTimeMacro | null, config: unknown): ProvenancedPermissionOutput {
  const base = {
    schemaVersion: "M14_A04_PERMISSION_PROVENANCE_V1" as const,
    decisionTime,
    macroInputIdentity: macro ? producerIdentity(macro) : "NONE" as const,
    macroAsOfTimestamp: macro?.asOfTimestamp ?? null,
    configIdentity: producerIdentity(config),
  };
  return immutableProducerCopy({ ...permission, provenance: { ...base, semanticIdentity: producerIdentity(permissionSemanticMaterial(permission, base)) } });
}

export function validatePermissionOutput(permission: PermissionOutput, macro?: PointInTimeMacro | null, config?: unknown): asserts permission is PermissionOutput & { readonly provenance: PermissionOutputProvenance } {
  const { provenance, ...material } = permission;
  if (!provenance) throw new Error("Permission provenance is required");
  const { semanticIdentity, ...base } = provenance;
  if (provenance.schemaVersion !== "M14_A04_PERMISSION_PROVENANCE_V1" || !Number.isFinite(provenance.decisionTime)) throw new Error("Invalid permission provenance contract");
  if (macro !== undefined && provenance.macroInputIdentity !== (macro ? producerIdentity(macro) : "NONE")) throw new Error("Permission macro identity mismatch");
  if (config !== undefined && provenance.configIdentity !== producerIdentity(config)) throw new Error("Permission config identity mismatch");
  if (semanticIdentity !== producerIdentity(permissionSemanticMaterial(material, base))) throw new Error("Permission semantic identity mismatch");
}

function riskSemanticMaterial(risk: RiskMaterial, provenance: Omit<RiskOutputProvenance, "semanticIdentity">) {
  return { ...provenance, risk };
}

export function createRiskOutput(risk: RiskMaterial, decisionTime: number, currentNav: number, peakNav: number, benchmarkBars: unknown, priorState: unknown, nextState: unknown, config: unknown): ProvenancedRiskOutput {
  const base = {
    schemaVersion: "M14_A04_RISK_PROVENANCE_V1" as const,
    decisionTime,
    valuationIdentity: null,
    valuationBindingStatus: "DEFERRED_TO_A04_STEP_2" as const,
    navInputIdentity: producerIdentity({ currentNav, peakNav }),
    benchmarkPrefixIdentity: producerIdentity(benchmarkBars),
    priorStateIdentity: producerIdentity(priorState),
    configIdentity: producerIdentity(config),
    nextStateIdentity: producerIdentity(nextState),
  };
  return immutableProducerCopy({ ...risk, provenance: { ...base, semanticIdentity: producerIdentity(riskSemanticMaterial(risk, base)) } });
}

export function validateRiskOutput(risk: RiskOutput): asserts risk is RiskOutput & { readonly provenance: RiskOutputProvenance } {
  const { provenance, ...material } = risk;
  if (!provenance) throw new Error("Risk provenance is required");
  const { semanticIdentity, ...base } = provenance;
  if (provenance.schemaVersion !== "M14_A04_RISK_PROVENANCE_V1" || provenance.valuationIdentity !== null || provenance.valuationBindingStatus !== "DEFERRED_TO_A04_STEP_2") throw new Error("Invalid risk provenance contract");
  if (semanticIdentity !== producerIdentity(riskSemanticMaterial(material, base))) throw new Error("Risk semantic identity mismatch");
}

export function validateRiskOutputAgainstInputs(risk: RiskOutput, currentNav: number, peakNav: number, benchmarkBars: unknown, priorState: unknown, nextState: unknown, config: unknown): void {
  validateRiskOutput(risk);
  if (risk.provenance.navInputIdentity !== producerIdentity({ currentNav, peakNav }) || risk.provenance.benchmarkPrefixIdentity !== producerIdentity(benchmarkBars) || risk.provenance.priorStateIdentity !== producerIdentity(priorState) || risk.provenance.nextStateIdentity !== producerIdentity(nextState) || risk.provenance.configIdentity !== producerIdentity(config)) throw new Error("Risk producer input identity mismatch");
}
