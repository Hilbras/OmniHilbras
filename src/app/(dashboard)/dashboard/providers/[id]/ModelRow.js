import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";
import ModelAliasEditor from "../components/ModelAliasEditor";

/**
 * Model row — old control-plane card design.
 *
 * Status tile on the left, model id + display name + caps in the middle,
 * copy / test / remove buttons on the right. The tile is green when the
 * last test passed, red when it failed, neutral otherwise.
 */
export default function ModelRow({
  model,
  fullModel,
  alias,
  copied,
  onCopy,
  onSetAlias,
  onClearAlias,
  testStatus,
  isCustom,
  isFree,
  onDeleteAlias,
  onTest,
  isTesting,
  onDisable,
  caps,
  thinkingSuffix,
}) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const copiedKey = `model-${model.id}`;

  const tileClass =
    testStatus === "ok"
      ? "border-success/25 bg-success/10 text-success"
      : testStatus === "error"
        ? "border-danger/25 bg-danger/10 text-danger"
        : "border-line bg-surface text-muted";

  const tileIcon =
    testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "memory";

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-3 rounded-xl border border-line bg-bg-soft/45 p-3.5 transition-colors hover:border-line-strong sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        {/* Status tile */}
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${tileClass}`}>
          <span
            className={`material-symbols-outlined text-[16px] ${isTesting ? "animate-spin text-gold-text" : ""}`}
            aria-hidden="true"
          >
            {isTesting ? "progress_activity" : tileIcon}
          </span>
        </span>

        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="truncate text-xs font-semibold" title={displayModel}>
              {displayModel}
            </p>
            {model.name && model.name !== model.id && (
              <p className="truncate text-[10px] text-muted">{model.name}</p>
            )}
            {alias && (
              <span className="shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[9px] text-muted">
                alias: {alias}
              </span>
            )}
            {isCustom && (
              <span className="shrink-0 rounded border border-gold/30 bg-gold-soft px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-gold-text">
                custom
              </span>
            )}
            {isFree && (
              <span className="shrink-0 rounded border border-success/25 bg-success/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-success">
                free
              </span>
            )}
            <CapacityBadges caps={caps} colorOverride="text-muted" size={12} />
          </div>
          <code className="mt-1 block truncate font-mono text-[10px] text-muted">
            {displayModel}
          </code>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* Alias */}
        {onSetAlias && (
          <ModelAliasEditor
            alias={alias}
            onSetAlias={onSetAlias}
            onClearAlias={onClearAlias}
          />
        )}

        {/* Copy */}
        <button
          type="button"
          onClick={() => onCopy(displayModel, copiedKey)}
          aria-label={`Copy ${model.id} model ID`}
          className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-gold-text"
        >
          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
            {copied === copiedKey ? "check" : "content_copy"}
          </span>
        </button>

        {/* Test */}
        {onTest && (
          <button
            type="button"
            onClick={onTest}
            disabled={isTesting}
            aria-label={`Test ${model.id}`}
            aria-busy={isTesting}
            className="btn-quiet !px-2 !py-2 !text-[11px]"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${isTesting ? "animate-spin" : ""}`}
              aria-hidden="true"
            >
              {isTesting ? "progress_activity" : "bolt"}
            </span>
            {isTesting ? "Testing" : "Test"}
          </button>
        )}

        {/* Remove / disable */}
        {isCustom ? (
          <button
            type="button"
            onClick={onDeleteAlias}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger"
            title="Remove custom model"
            aria-label={`Remove ${model.id}`}
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">close</span>
          </button>
        ) : onDisable ? (
          <button
            type="button"
            onClick={onDisable}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger sm:opacity-0 sm:group-hover/model-list:opacity-100"
            title="Disable this model"
            aria-label={`Disable ${model.id}`}
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">close</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onSetAlias: PropTypes.func,
  onClearAlias: PropTypes.func,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
