"use client";

import { useState } from "react";

import { UdmViewer } from "./UdmViewer";
import { UploadZone } from "./UploadZone";

interface UploadResult {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  ms_taken: number;
}

const DEFAULT_SRC = "/synthetic.udm.json";

export function HomeClient() {
  const [src, setSrc] = useState<string>(DEFAULT_SRC);
  const [meta, setMeta] = useState<UploadResult | null>(null);

  const handleUploaded = (result: UploadResult) => {
    setSrc(result.udm_url);
    setMeta(result);
  };

  return (
    <div className="space-y-6">
      <UploadZone onUploaded={handleUploaded} />
      {meta && (
        <div className="text-xs text-neutral-500 font-mono">
          Loaded: {meta.filename} · {(meta.size / 1024).toFixed(1)} KB · imported in{" "}
          {meta.ms_taken} ms · session{" "}
          <span className="text-neutral-400">{meta.session_id.slice(0, 8)}</span>
          {" · "}
          <button
            onClick={() => {
              setSrc(DEFAULT_SRC);
              setMeta(null);
            }}
            className="underline hover:text-neutral-700"
          >
            reset to synthetic
          </button>
        </div>
      )}
      <UdmViewer src={src} />
    </div>
  );
}
