import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProductSurfaceBoundary } from "../ProductSurfaceBoundary";
import { GlobalChatbot } from "../GlobalChatbot";
import { Sidebar } from "../layout/Sidebar";
import { buildCurrentMarketSnapshot } from "@/lib/macro/snapshot";
import type { MacroMetricId, MarketSnapshotData, UnavailableMacroDatum } from "@/lib/macro/types";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { useUiStore } from "@/stores/uiStore";
import { deriveTradingDecisionPresentation } from "@/views/TradingLabView";
import { MacroViewV2 } from "@/views/MacroViewV2";

const testDoubles = vi.hoisted(() => ({
  requestAiAdvisor: vi.fn(),
  coordinatorRecords: [] as Array<{
    coordinator: {
      isPending: () => boolean;
    };
    leases: Array<{ requestId: number; signal: AbortSignal }>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@/lib/aiGatewayClient", () => ({
  requestAiAdvisor: testDoubles.requestAiAdvisor,
}));

vi.mock("@/lib/chatRequestCoordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chatRequestCoordinator")>();
  return {
    ...actual,
    createChatRequestCoordinator: () => {
      const coordinator = actual.createChatRequestCoordinator();
      const record = {
        coordinator,
        leases: [] as Array<{ requestId: number; signal: AbortSignal }>,
        dispose: vi.fn(() => coordinator.dispose()),
      };
      testDoubles.coordinatorRecords.push(record);
      return {
        begin: () => {
          const lease = coordinator.begin();
          record.leases.push(lease);
          return lease;
        },
        isCurrent: coordinator.isCurrent,
        finish: coordinator.finish,
        dispose: record.dispose,
        isPending: coordinator.isPending,
      };
    },
  };
});

type TestListener = (event: TestDomEvent) => void;

class TestDomEvent {
  readonly type: string;
  target: TestDomNode | null = null;
  currentTarget: TestDomNode | null = null;
  bubbles = true;
  defaultPrevented = false;
  cancelBubble = false;
  button = 0;
  key = "";
  shiftKey = false;

  constructor(type: string, init: Partial<TestDomEvent> = {}) {
    this.type = type;
    Object.assign(this, init);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.cancelBubble = true;
  }
}

class TestDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  ownerDocument: TestDomDocument;
  parentNode: TestDomNode | null = null;
  childNodes: TestDomNode[] = [];
  private readonly listeners = new Map<string, Set<TestListener>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: TestDomDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): TestDomNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): TestDomNode | null {
    return this.childNodes.at(-1) ?? null;
  }

  get nextSibling(): TestDomNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "") this.appendChild(this.ownerDocument.createTextNode(value));
  }

  appendChild<T extends TestDomNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends TestDomNode>(child: T, before: TestDomNode | null): T {
    if (before === null) return this.appendChild(child);
    const index = this.childNodes.indexOf(before);
    if (index < 0) throw new Error("Reference node is not a child");
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild<T extends TestDomNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("Node is not a child");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  contains(node: TestDomNode | null): boolean {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  addEventListener(type: string, listener: TestListener): void {
    const listeners = this.listeners.get(type) ?? new Set<TestListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: TestDomEvent): boolean {
    event.target ??= this;
    for (let current: TestDomNode | null = this; current; current = event.bubbles ? current.parentNode : null) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(event.type) ?? []) listener(event);
      if (event.cancelBubble) break;
    }
    return !event.defaultPrevented;
  }
}

class TestDomText extends TestDomNode {
  data: string;

  constructor(data: string, ownerDocument: TestDomDocument) {
    super(3, "#text", ownerDocument);
    this.data = data;
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(value: string) {
    this.data = value;
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(value: string) {
    this.data = value;
  }
}

class TestDomComment extends TestDomText {
  constructor(data: string, ownerDocument: TestDomDocument) {
    super(data, ownerDocument);
    Object.defineProperty(this, "nodeType", { value: 8 });
    Object.defineProperty(this, "nodeName", { value: "#comment" });
  }
}

class TestDomElement extends TestDomNode {
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly style: Record<string, string> & { setProperty: (name: string, value: string) => void };
  private readonly attributes = new Map<string, string>();
  private currentValue = "";
  checked = false;
  disabled = false;
  selected = false;
  multiple = false;

  constructor(tagName: string, ownerDocument: TestDomDocument, namespaceURI = "http://www.w3.org/1999/xhtml") {
    const normalized = tagName.toUpperCase();
    super(1, normalized, ownerDocument);
    this.tagName = normalized;
    this.namespaceURI = namespaceURI;
    const style = {} as TestDomElement["style"];
    style.setProperty = (name, value) => { style[name] = value; };
    this.style = style;
  }

  get value(): string {
    return this.currentValue;
  }

  set value(value: string) {
    this.currentValue = String(value);
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(value: string) {
    this.setAttribute("class", value);
  }

  get type(): string {
    return this.getAttribute("type")
      ?? (this.tagName === "INPUT" ? "text" : this.tagName === "BUTTON" ? "submit" : "");
  }

  set type(value: string) {
    this.setAttribute("type", value);
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  scrollIntoView(): void {}
}

class TestDomDocument extends TestDomNode {
  readonly documentElement: TestDomElement;
  readonly body: TestDomElement;
  activeElement: TestDomElement;
  defaultView: Record<string, unknown> = {};

  constructor() {
    super(9, "#document", undefined as unknown as TestDomDocument);
    this.ownerDocument = this;
    this.documentElement = this.createElement("html");
    this.body = this.createElement("body");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }

  createElement(tagName: string): TestDomElement {
    return new TestDomElement(tagName, this);
  }

  createElementNS(namespaceURI: string, tagName: string): TestDomElement {
    return new TestDomElement(tagName, this, namespaceURI);
  }

  createTextNode(data: string): TestDomText {
    return new TestDomText(data, this);
  }

  createComment(data: string): TestDomComment {
    return new TestDomComment(data, this);
  }
}

interface InstalledTestDom {
  readonly document: TestDomDocument;
}

let installedDom: InstalledTestDom;

function installTestDom(): InstalledTestDom {
  const document = new TestDomDocument();
  const storage = new class {
    private readonly values = new Map<string, string>();

    get length(): number { return this.values.size; }
    clear(): void { this.values.clear(); }
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
    removeItem(key: string): void { this.values.delete(key); }
    setItem(key: string, value: string): void { this.values.set(key, String(value)); }
  }();
  class TestHtmlIFrameElement extends TestDomElement {}
  const windowObject = {
    document,
    Node: TestDomNode,
    Element: TestDomElement,
    HTMLElement: TestDomElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    HTMLInputElement: TestDomElement,
    HTMLTextAreaElement: TestDomElement,
    HTMLButtonElement: TestDomElement,
    HTMLFormElement: TestDomElement,
    Text: TestDomText,
    Comment: TestDomComment,
    Event: TestDomEvent,
    localStorage: storage,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  document.defaultView = windowObject;

  const globals: Record<string, unknown> = {
    window: windowObject,
    document,
    Node: TestDomNode,
    Element: TestDomElement,
    HTMLElement: TestDomElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    HTMLInputElement: TestDomElement,
    HTMLTextAreaElement: TestDomElement,
    HTMLButtonElement: TestDomElement,
    HTMLFormElement: TestDomElement,
    Event: TestDomEvent,
    localStorage: storage,
    navigator: { userAgent: "vitest-test-dom" },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  return { document };
}

function findElements(root: TestDomNode, predicate: (element: TestDomElement) => boolean): TestDomElement[] {
  const matches: TestDomElement[] = [];
  const visit = (node: TestDomNode): void => {
    if (node instanceof TestDomElement && predicate(node)) matches.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return matches;
}

function elementByText(root: TestDomNode, tagName: string, text: string): TestDomElement {
  const element = findElements(root, (candidate) => candidate.tagName === tagName.toUpperCase() && candidate.textContent.includes(text))[0];
  if (!element) throw new Error(`Unable to find ${tagName} containing ${text}`);
  return element;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function unavailableDatum(id: MacroMetricId): UnavailableMacroDatum {
  return {
    status: "UNAVAILABLE",
    id,
    value: null,
    sourceClassification: "UNAVAILABLE",
    provider: "TEST",
    instrument: id,
    quality: "UNAVAILABLE",
    reason: "Mounted consumer fixture",
  };
}

function mountedSnapshot() {
  const ids: MacroMetricId[] = ["dxy", "us2y", "us10y", "vix", "gold", "btc", "vnindex", "breadth", "liquidity", "foreignFlow"];
  const data = Object.fromEntries(ids.map((id) => [id, unavailableDatum(id)])) as unknown as MarketSnapshotData;
  return buildCurrentMarketSnapshot({ timestamp: 1_800_000_000_000, data });
}

async function mount(node: ReactNode) {
  const container = installedDom.document.createElement("div");
  installedDom.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  await act(async () => { root.render(node); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.parentNode?.removeChild(container);
    },
  };
}

async function dispatch(element: TestDomElement, type: string, init: Partial<TestDomEvent> = {}): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new TestDomEvent(type, init));
    await Promise.resolve();
  });
}

async function enterInputValue(input: TestDomElement, value: string): Promise<void> {
  const props = reactProps(input);
  const onChange = props.onChange;
  if (typeof onChange !== "function") throw new Error("Mounted input onChange handler is unavailable");
  input.value = value;
  await act(async () => {
    onChange({ target: { value } });
    await Promise.resolve();
  });
}

function reactProps(element: TestDomElement): Record<string, unknown> {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to mounted ${element.tagName}`);
  return (element as unknown as Record<string, Record<string, unknown>>)[propsKey];
}

async function submitMountedForm(form: TestDomElement): Promise<void> {
  const onSubmit = reactProps(form).onSubmit;
  if (typeof onSubmit !== "function") throw new Error("Mounted form onSubmit handler is unavailable");
  await act(async () => {
    onSubmit({ preventDefault: () => undefined });
    await Promise.resolve();
  });
}

beforeAll(() => {
  installedDom = installTestDom();
});

afterEach(() => {
  useUiStore.setState({ view: "lab" });
  useSnapshotStore.getState().setSnapshotDirect(null);
  testDoubles.requestAiAdvisor.mockReset();
  testDoubles.coordinatorRecords.length = 0;
  localStorage.clear();
});

describe("P16-D responsive product shell", () => {
  it("keeps Paper Action first and default while Research remains secondary", () => {
    expect(useUiStore.getState().view).toBe("lab");
    const html = renderToStaticMarkup(createElement(Sidebar));

    expect(html.indexOf("PAPER ACTION")).toBeGreaterThan(-1);
    expect(html.indexOf("RESEARCH / RULES")).toBeGreaterThan(html.indexOf("PAPER ACTION"));
    expect(html).toContain("Read-only evidence");
    expect(html).toContain("overflow-x-auto");
  });

  it("contains narrow-layout access and intentional overflow handling", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const action = readFileSync("src/components/ActionDecisionCard.tsx", "utf8");
    const research = readFileSync("src/views/ResearchRulesView.tsx", "utf8");
    const globalChat = readFileSync("src/components/GlobalChatbot.tsx", "utf8");

    expect(app).toContain("flex-col overflow-hidden");
    expect(app).toContain("md:flex-row");
    expect(action).toContain("break-all");
    expect(action).toContain("sm:grid-cols-3");
    expect(research).toContain("break-all");
    expect(research).toContain("minmax(0,1.1fr)");
    expect(globalChat).toContain("inset-x-2");
  });
});

describe("P16-D safe product render failure", () => {
  it("mounts an actual throwing child through the real neutral boundary fallback", async () => {
    function ThrowingChild(): never {
      throw new Error("sensitive runtime details");
    }

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mounted = await mount(createElement(
      ProductSurfaceBoundary,
      { surfaceName: "Paper Action", children: createElement(ThrowingChild) }
    ));

    expect(mounted.container.textContent).toContain("Paper Action is currently unavailable");
    expect(mounted.container.textContent).toContain("No canonical paper action, target weight, research status, or provider state was inferred from this failure");
    expect(mounted.container.textContent).not.toContain("presentation failure");
    expect(mounted.container.textContent).not.toMatch(/sensitive runtime details|stack|provider url|request metadata/iu);

    await mounted.unmount();
    errorLog.mockRestore();
  });

  it("does not fabricate risk or allocation when the canonical decision is absent", () => {
    const presentation = deriveTradingDecisionPresentation(null);

    expect(presentation).toEqual({
      riskAvailable: false,
      riskStatus: "UNAVAILABLE",
      riskReason: "Canonical risk state unavailable.",
      allocationSummary: "UNAVAILABLE",
      allocationRationale: "Canonical allocation unavailable.",
    });
    expect(JSON.stringify(presentation)).not.toMatch(/NORMAL|BTC: 0\.0%|Cash: 100\.0%/u);
  });
});

describe("P16-D mounted chat consumer coordination", () => {
  it("keeps GlobalChatbot loading for B when stale A completes, then publishes only B", async () => {
    const requestA = createDeferred<string>();
    const requestB = createDeferred<string>();
    testDoubles.requestAiAdvisor
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise);

    const mounted = await mount(createElement(GlobalChatbot));
    await dispatch(elementByText(mounted.container, "button", ""), "click");
    await dispatch(elementByText(mounted.container, "button", "Tóm tắt & Hành động"), "click");
    await dispatch(elementByText(mounted.container, "button", "Chiến lược 3 tháng"), "click");

    await act(async () => { requestA.resolve("STALE A RESPONSE"); await requestA.promise; });
    expect(mounted.container.textContent).toContain("Trợ lý đang suy luận dữ liệu");
    expect(mounted.container.textContent).not.toContain("STALE A RESPONSE");

    await act(async () => { requestB.resolve("AUTHORITATIVE B RESPONSE"); await requestB.promise; });
    expect(mounted.container.textContent).toContain("AUTHORITATIVE B RESPONSE");
    expect(mounted.container.textContent).not.toContain("STALE A RESPONSE");
    expect(mounted.container.textContent).not.toContain("Trợ lý đang suy luận dữ liệu");

    await mounted.unmount();
  });

  it("suppresses stale GlobalChatbot errors and invalidates the active lease on unmount", async () => {
    const requestA = createDeferred<string>();
    const requestB = createDeferred<string>();
    testDoubles.requestAiAdvisor
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise);

    const mounted = await mount(createElement(GlobalChatbot));
    await dispatch(elementByText(mounted.container, "button", ""), "click");
    await dispatch(elementByText(mounted.container, "button", "Tóm tắt & Hành động"), "click");
    await dispatch(elementByText(mounted.container, "button", "Chiến lược 3 tháng"), "click");

    await act(async () => { requestA.reject(new Error("stale A failure")); await requestA.promise.catch(() => undefined); });
    expect(mounted.container.textContent).toContain("Trợ lý đang suy luận dữ liệu");
    expect(mounted.container.textContent).not.toContain("Yêu cầu AI không thành công");

    const activeRecord = testDoubles.coordinatorRecords.find((record) => record.coordinator.isPending());
    expect(activeRecord?.leases.at(-1)?.signal.aborted).toBe(false);
    await mounted.unmount();
    expect(activeRecord?.dispose).toHaveBeenCalledOnce();
    expect(activeRecord?.leases.at(-1)?.signal.aborted).toBe(true);
    expect(activeRecord?.coordinator.isPending()).toBe(false);

    requestB.resolve("POST UNMOUNT RESPONSE");
    await requestB.promise;
  });

  it("keeps MacroViewV2 loading for B when stale A succeeds, then publishes only B", async () => {
    await act(async () => { useSnapshotStore.getState().setSnapshotDirect(mountedSnapshot()); });
    const requestA = createDeferred<string>();
    const requestB = createDeferred<string>();
    testDoubles.requestAiAdvisor
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise);

    const mounted = await mount(createElement(MacroViewV2));
    const input = findElements(mounted.container, (element) => element.tagName === "INPUT")[0];
    const form = findElements(mounted.container, (element) => element.tagName === "FORM")[0];
    if (!input) throw new Error("Macro chat input was not mounted");
    if (!form) throw new Error("Macro chat form was not mounted");

    await enterInputValue(input, "Request A");
    await submitMountedForm(form);
    await enterInputValue(input, "Request B");
    await submitMountedForm(form);
    expect(testDoubles.requestAiAdvisor).toHaveBeenCalledTimes(2);

    await act(async () => { requestA.resolve("STALE MACRO A SUCCESS"); await requestA.promise; });
    const activeRecord = testDoubles.coordinatorRecords.find((record) => record.coordinator.isPending());
    expect(activeRecord?.leases).toHaveLength(2);
    expect(activeRecord?.leases.at(-1)?.signal.aborted).toBe(false);
    expect(activeRecord?.coordinator.isPending()).toBe(true);
    expect(mounted.container.textContent).toContain("Trợ lý AI đang suy luận");
    expect(mounted.container.textContent).not.toContain("STALE MACRO A SUCCESS");

    await act(async () => { requestB.resolve("AUTHORITATIVE MACRO B SUCCESS"); await requestB.promise; });
    expect(activeRecord?.coordinator.isPending()).toBe(false);
    expect(mounted.container.textContent).toContain("AUTHORITATIVE MACRO B SUCCESS");
    expect(mounted.container.textContent).not.toContain("STALE MACRO A SUCCESS");
    expect(mounted.container.textContent).not.toContain("Trợ lý AI đang suy luận");

    await mounted.unmount();
  });

  it("wires MacroViewV2 to latest-request wins and unmount invalidation", async () => {
    await act(async () => { useSnapshotStore.getState().setSnapshotDirect(mountedSnapshot()); });
    const requestA = createDeferred<string>();
    const requestB = createDeferred<string>();
    testDoubles.requestAiAdvisor
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise);

    const mounted = await mount(createElement(MacroViewV2));
    const input = findElements(mounted.container, (element) => element.tagName === "INPUT")[0];
    const form = findElements(mounted.container, (element) => element.tagName === "FORM")[0];
    if (!input) throw new Error("Macro chat input was not mounted");
    if (!form) throw new Error("Macro chat form was not mounted");

    await enterInputValue(input, "Request A");
    await submitMountedForm(form);
    await enterInputValue(input, "Request B");
    await submitMountedForm(form);
    expect(testDoubles.requestAiAdvisor).toHaveBeenCalledTimes(2);

    await act(async () => { requestA.reject(new Error("stale macro failure")); await requestA.promise.catch(() => undefined); });
    expect(mounted.container.textContent).toContain("Trợ lý AI đang suy luận");
    expect(mounted.container.textContent).not.toContain("Yêu cầu AI không thành công");

    await act(async () => { requestB.resolve("AUTHORITATIVE MACRO B"); await requestB.promise; });
    expect(mounted.container.textContent).toContain("AUTHORITATIVE MACRO B");
    expect(mounted.container.textContent).not.toContain("stale macro failure");

    const activeRequest = createDeferred<string>();
    testDoubles.requestAiAdvisor.mockImplementationOnce(() => activeRequest.promise);
    await enterInputValue(input, "Unmount request");
    await submitMountedForm(form);
    const activeRecord = testDoubles.coordinatorRecords.find((record) => record.coordinator.isPending());
    await mounted.unmount();
    expect(activeRecord?.dispose).toHaveBeenCalledOnce();
    expect(activeRecord?.leases.at(-1)?.signal.aborted).toBe(true);
    expect(activeRecord?.coordinator.isPending()).toBe(false);

    activeRequest.resolve("POST UNMOUNT MACRO RESPONSE");
    await activeRequest.promise;
  });
});
