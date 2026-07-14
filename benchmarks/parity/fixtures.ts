import type { ParityFixture } from "./types.js";

function lines(count: number, render: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => render(index)).join("\n");
}

const jsonFact = "ERROR auth refresh rejected for tenant-critical";
const searchFact = "src/security/session.ts:417:ERROR rotateCredential rejected";
const logFact = "AuthRotationError: credential rotation failed at auth.ts:93";
const textFact = "SECURITY DECISION HR-204: rotate the release credential before publish.";
const codeSignature =
  "export async function rotateCredential(tenantId: TenantId): Promise<RotationResult>";
const diffFact = "+  throw new AuthRotationError(\"credential rotation failed\");";
const tableFact = "| tenant-critical | ERROR | rotate-before-publish |";
const htmlFact = "Security incident HR-204 requires credential rotation before publish.";
const mixedFact = "ERROR mixed-output authorization rejected at worker.ts:71";

const jsonRows = Array.from({ length: 160 }, (_, index) => ({
  id: index + 1,
  status: index === 117 ? "ERROR" : "ok",
  message: index === 117 ? jsonFact : `routine event ${index + 1}`,
  shard: `zone-${index % 8}`,
}));

const code = [
  'import { audit } from "./audit.js";',
  'import { AuthRotationError } from "./errors.js";',
  "",
  "export type TenantId = string & { readonly tenant: unique symbol };",
  "export interface RotationResult { rotatedAt: string; keyId: string }",
  "",
  `${codeSignature} {`,
  '  audit.info("rotation requested", { tenantId });',
  '  if (tenantId === "tenant-critical") {',
  '    throw new AuthRotationError("credential rotation failed");',
  "  }",
  '  return { rotatedAt: new Date().toISOString(), keyId: "key-next" };',
  "}",
  "",
  lines(90, (index) =>
    [
      `function routineHelper${index}(value: number): number {`,
      `  const adjusted = value + ${index};`,
      "  return adjusted;",
      "}",
    ].join("\n"),
  ),
].join("\n");

const diff = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 92a1b11..da84190 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -87,7 +87,10 @@ export async function rotateCredential(tenantId: TenantId) {",
  "   const current = await loadCredential(tenantId);",
  "-  return persistCredential(current);",
  "+  if (tenantId === \"tenant-critical\") {",
  diffFact,
  "+  }",
  "+  return persistCredential(current.next);",
  " }",
  ...Array.from({ length: 70 }, (_, index) => [
    `diff --git a/src/routine-${index}.ts b/src/routine-${index}.ts`,
    `--- a/src/routine-${index}.ts`,
    `+++ b/src/routine-${index}.ts`,
    "@@ -1,3 +1,3 @@",
    `-export const value${index} = ${index};`,
    `+export const value${index} = ${index + 1};`,
    " export const stable = true;",
  ].join("\n")),
].join("\n");

const table = [
  "| tenant | status | action |",
  "| --- | --- | --- |",
  ...Array.from({ length: 180 }, (_, index) =>
    index === 143
      ? tableFact
      : `| tenant-${String(index).padStart(3, "0")} | ok | none |`,
  ),
].join("\n");

const html = [
  "<!doctype html><html><head>",
  "<title>Security Runbook HR-204</title>",
  "<style>.noise{display:none}</style><script>window.tracking=true</script>",
  "</head><body><nav>Home Products Pricing Changelog</nav><main>",
  `<h1>Credential rotation</h1><p>${htmlFact}</p>`,
  '<a href="/runbooks/hr-204">Open the HR-204 runbook</a>',
  "<table><tr><th>tenant</th><th>status</th></tr>",
  "<tr><td>tenant-critical</td><td>ERROR</td></tr></table>",
  lines(120, (index) => `<p>Routine operational note ${index} is stable.</p>`),
  "</main><footer>Legal Privacy Status</footer></body></html>",
].join("\n");

export const PARITY_FIXTURES: readonly ParityFixture[] = [
  {
    id: "json-priority-row",
    kind: "json",
    tool: "Bash",
    query: "tenant-critical auth refresh error",
    content: JSON.stringify(jsonRows, null, 2),
    protectedFacts: [jsonFact, '"id": 118'],
  },
  {
    id: "search-relevant-tail",
    kind: "search",
    tool: "Bash",
    query: "rotateCredential tenant-critical",
    content: [
      lines(180, (index) =>
        `src/routine/file-${index % 24}.ts:${index + 1}:routine match ${index}`,
      ),
      searchFact,
    ].join("\n"),
    protectedFacts: [searchFact],
  },
  {
    id: "log-error-stack",
    kind: "log",
    tool: "Bash",
    query: "credential rotation failure",
    content: [
      "INFO build started",
      lines(150, (index) => `INFO routine unit ${index} passed`),
      "ERROR tenant-critical rotation failed",
      "Traceback (most recent call last):",
      '  File "auth.py", line 93, in rotate_credential',
      logFact,
      "Build failed: 1 failed, 150 passed",
    ].join("\n"),
    protectedFacts: [logFact, 'File "auth.py", line 93'],
  },
  {
    id: "text-security-decision",
    kind: "text",
    tool: "WebFetch",
    query: "release credential decision HR-204",
    content: [
      "# Release readiness review",
      textFact,
      lines(130, (index) =>
        `Routine readiness paragraph ${index} confirms the standard checklist is complete.`,
      ),
      "Action: block publishing until HR-204 is resolved.",
    ].join("\n\n"),
    protectedFacts: [textFact, "Action: block publishing until HR-204 is resolved."],
  },
  {
    id: "code-signature-and-type",
    kind: "code",
    tool: "Read",
    query: "rotateCredential TenantId AuthRotationError",
    content: code,
    protectedFacts: [
      codeSignature,
      "export type TenantId = string & { readonly tenant: unique symbol };",
      'throw new AuthRotationError("credential rotation failed");',
    ],
  },
  {
    id: "diff-auth-change",
    kind: "diff",
    tool: "Bash",
    query: "auth credential rotation diff",
    content: diff,
    protectedFacts: [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "@@ -87,7 +87,10 @@ export async function rotateCredential(tenantId: TenantId) {",
      diffFact,
    ],
  },
  {
    id: "table-abnormal-row",
    kind: "table",
    tool: "Bash",
    query: "tenant-critical error action",
    content: table,
    protectedFacts: ["| tenant | status | action |", tableFact],
  },
  {
    id: "html-main-security-content",
    kind: "html",
    tool: "WebFetch",
    query: "HR-204 credential rotation runbook",
    content: html,
    protectedFacts: [
      "Security Runbook HR-204",
      htmlFact,
      "tenant-critical",
      "/runbooks/hr-204",
    ],
  },
  {
    id: "mixed-stdout-stderr",
    kind: "mixed",
    tool: "Bash",
    query: "mixed authorization worker error",
    content: [
      "<returncode>1</returncode>",
      `<stdout>\n${lines(110, (index) => `INFO routine worker ${index} ready`)}\n</stdout>`,
      `<stderr>\n${mixedFact}\nTraceback: worker.ts:71\n</stderr>`,
    ].join("\n"),
    protectedFacts: [mixedFact, "Traceback: worker.ts:71"],
  },
];
