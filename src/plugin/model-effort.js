const STANDARD_EFFORTS = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "max",
    "xhigh",
]);

function hasOwn(value, key) {
    return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeEffort(value) {
    if (typeof value !== "string") return "";
    return value.trim().toLowerCase();
}

export function normalizeVariant(value) {
    if (typeof value !== "string") return "";
    return value.trim();
}

export function modelReferenceFromInfo(info) {
    if (!info || typeof info !== "object") return info;

    const topLevelVariant = ["variant", "variantID", "modelVariant"].find((key) => hasOwn(info, key));
    const model = info.model;
    if (model !== undefined && model !== null) {
        if (typeof model !== "object") {
            if (info.providerID === undefined && topLevelVariant === undefined) return model;
            return {
                modelID: model,
                ...(info.providerID !== undefined ? { providerID: info.providerID } : {}),
                ...(topLevelVariant !== undefined ? { variant: info[topLevelVariant] } : {}),
            };
        }
        if (info.providerID === undefined && topLevelVariant === undefined) return model;
        return {
            ...model,
            ...(model.providerID === undefined && info.providerID !== undefined ? { providerID: info.providerID } : {}),
            ...(model.variant === undefined && topLevelVariant !== undefined ? { variant: info[topLevelVariant] } : {}),
        };
    }

    if (info.modelID === undefined) {
        const looksLikeModelRef = info.id !== undefined
            && info.providerID !== undefined
            && info.time === undefined
            && info.role === undefined
            && info.type === undefined;
        return looksLikeModelRef ? info : null;
    }

    return {
        modelID: info.modelID,
        ...(info.providerID !== undefined ? { providerID: info.providerID } : {}),
        ...(topLevelVariant !== undefined ? { variant: info[topLevelVariant] } : {}),
    };
}

export function extractModelReference(value) {
    if (!value) return { id: null, providerID: null, variant: "", hasVariant: false };

    if (typeof value === "string") {
        let raw = value.trim();
        let variant = "";
        let hasVariant = false;
        const hash = raw.indexOf("#");
        if (hash !== -1) {
            variant = normalizeVariant(raw.slice(hash + 1));
            raw = raw.slice(0, hash);
            hasVariant = true;
        }
        const slash = raw.indexOf("/");
        if (slash > 0) {
            return {
                id: raw.slice(slash + 1),
                providerID: raw.slice(0, slash),
                variant,
                hasVariant,
            };
        }
        return { id: raw || null, providerID: null, variant, hasVariant };
    }

    if (typeof value !== "object") {
        return { id: null, providerID: null, variant: "", hasVariant: false };
    }

    let providerID = value.providerID ?? value.provider ?? null;
    let rawID = value.id ?? value.modelID ?? value.model ?? null;
    let variant = normalizeVariant(value.variant ?? value.variantID);
    let hasVariant = hasOwn(value, "variant") || hasOwn(value, "variantID");

    if (typeof rawID === "string") {
        rawID = rawID.trim();
        const hash = rawID.indexOf("#");
        if (hash !== -1) {
            if (!hasVariant) variant = normalizeVariant(rawID.slice(hash + 1));
            rawID = rawID.slice(0, hash);
            hasVariant = true;
        }
        const slash = rawID.indexOf("/");
        if (slash > 0) {
            if (!providerID) providerID = rawID.slice(0, slash);
            rawID = rawID.slice(slash + 1);
        }
    }

    return {
        id: rawID || null,
        providerID,
        variant,
        hasVariant,
    };
}

function variantDefinition(modelInfo, variant) {
    if (!modelInfo || !variant) return null;
    const variants = modelInfo.variants;
    if (Array.isArray(variants)) {
        return variants.find((item) => normalizeVariant(item?.id).toLowerCase() === variant.toLowerCase()) ?? null;
    }
    if (variants && typeof variants === "object") {
        const direct = variants[variant] ?? variants[variant.toLowerCase()];
        if (direct && typeof direct === "object") return direct;
        const entry = Object.entries(variants).find(([id]) => id.toLowerCase() === variant.toLowerCase());
        return entry?.[1] && typeof entry[1] === "object" ? entry[1] : null;
    }
    return null;
}

export function resolveEffort(variant, modelInfo) {
    const normalizedVariant = normalizeVariant(variant);
    if (!normalizedVariant) return "";

    const canonicalVariant = normalizedVariant.toLowerCase();
    if (STANDARD_EFFORTS.has(canonicalVariant)) return canonicalVariant;

    const definition = variantDefinition(modelInfo, normalizedVariant);
    const configured = definition?.settings?.reasoningEffort
        ?? definition?.reasoningEffort
        ?? definition?.options?.reasoningEffort;
    return normalizeEffort(configured);
}

export function modelCatalogKeys(providerID, modelID) {
    if (typeof modelID !== "string" || !modelID) return [];
    const base = modelID.split("#", 1)[0];
    const parts = base.split("/");
    const keys = [];
    for (let i = 0; i < parts.length; i += 1) {
        const candidate = parts.slice(i).join("/");
        if (!candidate) continue;
        if (providerID) {
            const qualified = `${providerID}/${candidate}`;
            if (!keys.includes(qualified)) keys.push(qualified);
        }
        if (!keys.includes(candidate)) keys.push(candidate);
    }
    return keys;
}

export function rememberModelInfo(catalog, modelInfo, providerOverride = null, modelIDOverride = null) {
    if (!catalog || !modelInfo || typeof modelInfo !== "object") return;
    const providerID = modelInfo.providerID ?? providerOverride ?? null;
    const ids = [
        modelIDOverride,
        modelInfo.modelID,
        modelInfo.id,
    ].filter((value, index, values) => typeof value === "string" && value && values.indexOf(value) === index);
    for (const id of ids) {
        for (const key of modelCatalogKeys(providerID, id)) catalog.set(key, modelInfo);
    }
}

export function findModelInfo(catalog, providerID, modelID) {
    if (!catalog) return null;
    for (const key of modelCatalogKeys(providerID, modelID)) {
        if (catalog.has(key)) return catalog.get(key);
    }
    return null;
}
