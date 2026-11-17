"use client";

import React, {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { providerInitials } from "./ModelsConfig-types";
import type { ModelOption } from "./ChatInput-model-options";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "./ui/primitives";

const FAVORITE_MODELS_KEY = "keylime:favorite-models";

function readFavoriteModels(): Set<string> {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(FAVORITE_MODELS_KEY) ?? "null",
    );
    if (Array.isArray(value)) {
      return new Set(
        value.filter((key): key is string => typeof key === "string"),
      );
    }
  } catch {
    // The picker still works when storage is unavailable.
  }
  return new Set();
}

function modelKey({ provider, modelId }: ModelOption): string {
  return `${provider}:${modelId}`;
}

export interface ProviderModelGroup {
  provider: string;
  options: ModelOption[];
}

export function groupModelOptionsByProvider(
  options: ModelOption[],
): ProviderModelGroup[] {
  const groups: ProviderModelGroup[] = [];
  const byProvider = new Map<string, ProviderModelGroup>();
  for (const option of options) {
    let group = byProvider.get(option.provider);
    if (!group) {
      group = { provider: option.provider, options: [] };
      byProvider.set(option.provider, group);
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

/** Current model's provider first so the picker opens on what you're already using. */
export function orderProviderGroups(
  groups: ProviderModelGroup[],
  currentProvider: string | null | undefined,
): ProviderModelGroup[] {
  if (!currentProvider) return groups;
  const index = groups.findIndex((g) => g.provider === currentProvider);
  if (index <= 0) return groups;
  const next = [...groups];
  const [active] = next.splice(index, 1);
  next.unshift(active);
  return next;
}

export function ProviderBadge({
  id,
  size = 16,
}: {
  id: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {providerInitials(id)}
    </span>
  );
}

export interface ModelPickerPanelProps {
  /** All visible options (already filtered by composer-picker visibility). */
  modelOptions: ModelOption[];
  /** Options matching the current search query. */
  filteredModelOptions: ModelOption[];
  currentModel?: { provider: string; modelId: string } | null;
  modelSearchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  showModelsLoading?: boolean;
  modelsRefreshing?: boolean;
  modelError?: string | null;
  onRefreshModels?: () => void;
  selectionDisabled?: boolean;
  isMobile?: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  onClose?: () => void;
}

/** Favorites are always shown first. The remaining models retain provider navigation. */
export function ModelPickerPanel({
  modelOptions,
  filteredModelOptions,
  currentModel,
  modelSearchQuery,
  onSearchQueryChange,
  searchInputRef,
  showModelsLoading,
  modelsRefreshing,
  modelError,
  onRefreshModels,
  selectionDisabled,
  isMobile,
  onSelectModel,
  onClose,
}: ModelPickerPanelProps) {
  const { t } = useI18n();
  const searching = modelSearchQuery.trim().length > 0;
  const [favoriteModels, setFavoriteModels] = useState(readFavoriteModels);
  const [otherModelsOpen, setOtherModelsOpen] = useState(false);
  const [collapsedSearch, setCollapsedSearch] = useState<string | null>(null);
  const panelId = useId();
  const otherModelsTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFavoriteFocus = useRef<string | null>(null);
  const open = searching
    ? collapsedSearch !== modelSearchQuery
    : otherModelsOpen;
  const [favorites, otherModels] = useMemo(() => {
    const favorites: ModelOption[] = [];
    const otherModels: ModelOption[] = [];
    for (const option of searching ? filteredModelOptions : modelOptions) {
      (favoriteModels.has(modelKey(option)) ? favorites : otherModels).push(
        option,
      );
    }
    return [favorites, otherModels];
  }, [favoriteModels, filteredModelOptions, modelOptions, searching]);
  const groups = useMemo(
    () =>
      orderProviderGroups(
        groupModelOptionsByProvider(otherModels),
        currentModel?.provider,
      ),
    [otherModels, currentModel?.provider],
  );

  useLayoutEffect(() => {
    const id = restoreFavoriteFocus.current;
    if (id === null) return;
    restoreFavoriteFocus.current = null;
    (document.getElementById(id) ?? otherModelsTriggerRef.current)?.focus();
  }, [favoriteModels]);

  const toggleFavorite = (key: string) => {
    const next = new Set(favoriteModels);
    if (!next.delete(key)) next.add(key);
    setFavoriteModels(next);
    try {
      window.localStorage.setItem(
        FAVORITE_MODELS_KEY,
        JSON.stringify([...next]),
      );
    } catch {
      // Keep the change in the open picker even if storage is unavailable.
    }
  };

  // Provider selection is explicit. Hover-driven pane changes make the list
  // flicker while the pointer crosses the picker.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const selectedProviderAvailable = groups.some(
    (group) => group.provider === selectedProvider,
  );
  const currentProviderAvailable = groups.some(
    (group) => group.provider === currentModel?.provider,
  );
  const activeProvider = selectedProviderAvailable
    ? selectedProvider
    : currentProviderAvailable
      ? (currentModel?.provider ?? null)
      : (groups[0]?.provider ?? null);

  const leftModels =
    groups.find((group) => group.provider === activeProvider)?.options ?? [];
  const multipleProviders = groups.length > 1;
  const showProviderRail =
    multipleProviders &&
    !searching &&
    (!isMobile || !selectedProviderAvailable);
  const showModelPane = !showProviderRail || !isMobile;

  const renderModelRow = (opt: ModelOption, showProvider = false) => {
    const key = modelKey(opt);
    const favorite = favoriteModels.has(key);
    const name = opt.name || opt.modelId;
    const favoriteId = `${panelId}-favorite-${encodeURIComponent(key)}`;
    const isActive =
      Boolean(currentModel) &&
      opt.modelId === currentModel?.modelId &&
      opt.provider === currentModel?.provider;
    return (
      <div className="picker-model-row" key={key}>
        <button
          className="picker-row"
          data-active={isActive}
          type="button"
          role="menuitemradio"
          aria-checked={isActive}
          disabled={selectionDisabled}
          onClick={() => onSelectModel(opt.provider, opt.modelId)}
        >
          <span className="picker-check">
            {isActive && (
              <Check size={11} strokeWidth={2.4} aria-hidden="true" />
            )}
          </span>
          <span className="picker-model-name">{name}</span>
          {showProvider && (
            <span className="picker-row-meta">{opt.provider}</span>
          )}
        </button>
        <button
          id={favoriteId}
          className="picker-model-star"
          type="button"
          aria-pressed={favorite}
          aria-label={t("chatInput.favoriteModel", {
            name,
            provider: opt.provider,
          })}
          title={t(
            favorite
              ? "chatInput.removeFavoriteModel"
              : "chatInput.addFavoriteModel",
          )}
          onClick={(event) => {
            if (document.activeElement === event.currentTarget) {
              restoreFavoriteFocus.current = favoriteId;
            }
            toggleFavorite(key);
          }}
        >
          <Star
            size={14}
            fill={favorite ? "currentColor" : "none"}
            aria-hidden="true"
          />
        </button>
      </div>
    );
  };

  return (
    <>
      <label className="picker-search">
        <Search
          size={13}
          strokeWidth={1.8}
          color="var(--text-dim)"
          aria-hidden="true"
        />
        <input
          ref={searchInputRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={modelSearchQuery}
          onChange={(e) => {
            setCollapsedSearch(null);
            onSearchQueryChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose?.();
            }
          }}
          placeholder={t("chatInput.searchModels")}
          aria-label={t("chatInput.searchModels")}
        />
      </label>
      {onRefreshModels && (
        <button
          type="button"
          className="picker-row"
          onClick={onRefreshModels}
          disabled={showModelsLoading}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {modelsRefreshing
            ? t("chatInput.refreshingModels")
            : showModelsLoading
              ? t("chatInput.loadingModels")
              : t("chatInput.refreshModels")}
        </button>
      )}
      {modelError && (
        <div
          role="alert"
          style={{
            color: "var(--status-error)",
            padding: "4px 12px",
            overflowWrap: "anywhere",
          }}
        >
          {modelError}
        </div>
      )}

      <div className="picker-model-list">
        {favorites.length > 0 && (
          <div role="group" aria-label={t("chatInput.favoriteModels")}>
            <div className="picker-group-label">
              {t("chatInput.favoriteModels")}
            </div>
            {favorites.map((opt) => renderModelRow(opt, true))}
          </div>
        )}
        {otherModels.length > 0 && (
          <Collapsible
            open={open}
            onOpenChange={(next) => {
              if (searching) setCollapsedSearch(next ? null : modelSearchQuery);
              else setOtherModelsOpen(next);
            }}
          >
            <CollapsibleTrigger
              ref={otherModelsTriggerRef}
              className="picker-row picker-other-models"
            >
              <ChevronDown size={13} aria-hidden="true" />
              {t("chatInput.otherModels")}
            </CollapsibleTrigger>
            <CollapsiblePanel
              className="picker-nested"
              data-split-pane={showProviderRail && showModelPane}
            >
              {showProviderRail && (
                <div
                  className="picker-nested-providers"
                  role="group"
                  aria-label={t("chatInput.providersLabel")}
                >
                  {groups.map((group) => {
                    const isCurrent = currentModel?.provider === group.provider;
                    const isActive = activeProvider === group.provider;
                    return (
                      <button
                        key={group.provider}
                        type="button"
                        className="picker-row picker-provider-row"
                        data-active={isActive}
                        data-current={isCurrent}
                        onClick={() => setSelectedProvider(group.provider)}
                        aria-current={isCurrent ? "true" : undefined}
                        aria-controls={`${panelId}-options`}
                      >
                        <ProviderBadge id={group.provider} size={15} />
                        <span className="picker-model-name">
                          {group.provider}
                        </span>
                        <ChevronRight
                          size={12}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                </div>
              )}
              {showModelPane && (
                <div
                  id={`${panelId}-options`}
                  className="picker-nested-models"
                  role="group"
                  aria-label={t("chatInput.modelsLabel")}
                >
                  {multipleProviders && isMobile && !searching && (
                    <button
                      type="button"
                      className="picker-row"
                      onClick={() => setSelectedProvider(null)}
                    >
                      <ChevronLeft
                        size={13}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      <span>{activeProvider}</span>
                    </button>
                  )}
                  {searching
                    ? groups.map((group) => (
                        <div key={group.provider}>
                          <div className="picker-group-label">
                            {group.provider}
                          </div>
                          {group.options.map((opt) => renderModelRow(opt))}
                        </div>
                      ))
                    : leftModels.map((opt) => renderModelRow(opt))}
                </div>
              )}
            </CollapsiblePanel>
          </Collapsible>
        )}
        {favorites.length === 0 && otherModels.length === 0 && (
          <div className="picker-empty">
            {showModelsLoading
              ? t("chatInput.loadingModels")
              : searching
                ? t("chatInput.noMatchingModels")
                : t("chatInput.noAvailableModels")}
          </div>
        )}
      </div>
    </>
  );
}
