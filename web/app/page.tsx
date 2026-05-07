import { HomeClient } from "@/components/HomeClient";

export default function HomePage() {
  return (
    <main className="min-h-screen px-6 py-10 max-w-6xl mx-auto">
      <header className="mb-8">
        <h1 className="text-4xl font-bold tracking-tight">AllDocs</h1>
        <p className="mt-2 text-neutral-600 max-w-2xl">
          Universal document editor and converter. Drop a PDF below to import it into the
          Universal Document Model (UDM) and render the result. Read-only for now; the editor
          lands in Phase 2.
        </p>
        <p className="mt-1 text-xs text-neutral-500 font-mono">
          UDM v0.1.0 · spec: docs/UDM_SPEC.md · schema: proto/udm.schema.json
        </p>
      </header>
      <HomeClient />
    </main>
  );
}
