"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, Badge, Button, CardSkeleton, SegmentedControl } from "@/shared/components";
import Drawer from "@/shared/components/Drawer";
import { ConfirmModal } from "@/shared/components/Modal";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";
import { SKILLS_TREE_URL, getSkillRawUrl } from "@/shared/constants/skills";

const TABS = [
  { value: "discover", label: "Discover" },
  { value: "mine", label: "My Skills" },
];

function CopyButton({ value, label = "Copy link", copiedLabel = "Copied!" }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <button
      onClick={() => copy(value)}
      className="px-2 py-1 rounded-md bg-primary text-white text-[11px] font-medium hover:bg-primary/90 transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1"
      title={value}
    >
      <span className="material-symbols-outlined text-[12px]">
        {copied ? "check" : "content_copy"}
      </span>
      {copied ? copiedLabel : label}
    </button>
  );
}

function SkillRow({ skill, busy, onInstall, onUninstall, onView, mode }) {
  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row sm:items-start gap-3 p-4 rounded-[14px] border shadow-[var(--shadow-soft)] transition-colors",
        skill.isEntry ? "border-brand-500/40 bg-brand-500/5" : "border-border-subtle bg-surface hover:bg-surface-2"
      )}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div
          className={cn(
            "size-9 rounded-lg flex items-center justify-center shrink-0",
            skill.isEntry ? "bg-primary text-white" : "bg-primary/10 text-primary"
          )}
        >
          <span className="material-symbols-outlined text-[18px]">{skill.icon}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onView(skill)} className="font-semibold text-sm text-text-main hover:text-primary text-left">
              {skill.name}
            </button>
            {skill.isEntry && <Badge variant="primary" size="sm">START HERE</Badge>}
            {skill.installed && <Badge variant="success" size="sm">Installed</Badge>}
            {skill.updateAvailable && <Badge variant="warning" size="sm">Update available</Badge>}
            {skill.endpoint && (
              <Badge variant="default" size="sm">
                <code className="text-[10px]">{skill.endpoint}</code>
              </Badge>
            )}
          </div>
          <p className="text-xs text-text-muted mt-0.5">{skill.description}</p>
          {mode === "mine" && skill.path && (
            <p className="text-[11px] text-text-muted mt-1 font-mono break-all">{skill.path}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap sm:justify-end shrink-0">
        {mode === "mine" && skill.path && <CopyButton value={skill.path} label="Copy path" />}
        {skill.rawUrl && <CopyButton value={skill.rawUrl} />}
        {!skill.installed && (
          <Button size="sm" variant="primary" icon="download" loading={busy} onClick={() => onInstall(skill)}>
            Install
          </Button>
        )}
        {skill.updateAvailable && (
          <Button size="sm" variant="outline" icon="update" loading={busy} onClick={() => onInstall(skill)}>
            Update
          </Button>
        )}
        {skill.installed && (
          <Button size="sm" variant="ghost" icon="delete" disabled={busy} onClick={() => onUninstall(skill)}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

export default function SkillsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <SkillsContent />
    </Suspense>
  );
}

function SkillsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabFromUrl = searchParams.get("tab");
  const activeTab = TABS.some((t) => t.value === tabFromUrl) ? tabFromUrl : "discover";

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [skills, setSkills] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [removing, setRemoving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = activeTab === "mine"
        ? "/api/skills/mine"
        : `/api/skills?${new URLSearchParams({ q: query, category })}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSkills(data.skills || []);
      if (data.categories) setCategories(data.categories);
    } catch (err) {
      setError(err.message);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab, query, category]);

  useEffect(() => {
    // Debounce typing; tab and category changes are just as cheap to delay.
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/skills?${params.toString()}`, { scroll: false });
  };

  const install = async (skill) => {
    setBusyId(skill.id);
    setError(null);
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skill.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async () => {
    const skill = removing;
    setBusyId(skill.id);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRemoving(null);
      await load();
    } catch (err) {
      setError(err.message);
      setRemoving(null);
    } finally {
      setBusyId(null);
    }
  };

  const view = async (skill) => {
    setViewing({ ...skill, content: null });
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setViewing({ ...data.skill, content: data.installedContent ?? data.skill.content });
    } catch (err) {
      setViewing({ ...skill, content: `Failed to load: ${err.message}` });
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card padding="md">
        <div className="text-xs text-text-muted mb-2">Paste this to your AI:</div>
        <div className="px-3 py-2 rounded bg-surface-2 font-mono text-[12px] text-text-main break-all">
          Read this skill and use it: {getSkillRawUrl("omnihilbras")}
        </div>
      </Card>

      <SegmentedControl options={TABS} value={activeTab} onChange={handleTabChange} className="w-full sm:w-auto" />

      {activeTab === "discover" && (
        <div className="space-y-3">
          <div className="relative">
            <span className="material-symbols-outlined text-[18px] text-text-muted absolute left-3 top-1/2 -translate-y-1/2">search</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills"
              aria-label="Search skills"
              className="w-full py-2.5 pl-10 pr-3 text-sm text-text-main bg-surface-2 rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {[{ id: "", label: "All" }, ...categories].map((c) => (
              <button
                key={c.id || "all"}
                onClick={() => setCategory(c.id)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                  category === c.id
                    ? "bg-primary text-white border-primary"
                    : "bg-surface text-text-muted border-border-subtle hover:text-text-main"
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="space-y-2">
        {loading && skills.length === 0 ? (
          <CardSkeleton />
        ) : skills.length === 0 ? (
          <Card padding="md">
            <p className="text-sm text-text-muted text-center">
              {activeTab === "mine"
                ? "No skills installed yet. Install one from Discover to keep a local copy for your agents."
                : "No skills match your search."}
            </p>
          </Card>
        ) : (
          skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              mode={activeTab}
              busy={busyId === skill.id}
              onInstall={install}
              onUninstall={setRemoving}
              onView={view}
            />
          ))
        )}
      </div>

      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-text-main">More on GitHub</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Browse source, README, and examples.
            </p>
          </div>
          <a
            href={SKILLS_TREE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary hover:underline inline-flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[16px]">open_in_new</span>
            View on GitHub
          </a>
        </div>
      </Card>

      <Drawer isOpen={!!viewing} onClose={() => setViewing(null)} title={viewing?.name || "Skill"} width="lg">
        {viewing && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {viewing.content && <CopyButton value={viewing.content} label="Copy SKILL.md" />}
              {viewing.rawUrl && <CopyButton value={`Read this skill and use it: ${viewing.rawUrl}`} label="Copy prompt" />}
            </div>
            {viewing.updateAvailable && (
              <p className="text-xs text-amber-600">Showing your installed version; a newer version is in the catalog.</p>
            )}
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/[0.03] dark:bg-white/[0.03] p-4 text-xs font-mono text-text-main">
              {viewing.content ?? "Loading…"}
            </pre>
          </div>
        )}
      </Drawer>

      <ConfirmModal
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={uninstall}
        title="Remove skill"
        message={removing ? `Remove ${removing.name}? Its local SKILL.md copy will be deleted.` : ""}
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
        loading={!!busyId}
      />
    </div>
  );
}
