import { STATE } from "../shared/constants.js";

export class SessionState {
    constructor(sid) {
        this.sessionID = sid;
        this.agent = "unknown";
        this.model = "unknown";
        this.provider = "unknown";
        this.mode = "unknown";
        this.state = STATE.WAITING;
        this.startedAt = Date.now();
        this.lastActivity = Date.now();
        this.promptCount = 0;
        this.modelLimit = null;
        this.currency = "$";
        this._cost = 0;
        this._tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
        this._messageMap = new Map();
        this._latestMessageID = null;
        this._latestMessageTime = 0;
        this._latestContextTokens = 0;
    }

    get cost() { return this._cost; }
    get totalTokens() {
        const t = this._tokens;
        return t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
    }
    get contextTokens() { return this._latestContextTokens; }
    get contextPercent() {
        return this.modelLimit && this.modelLimit > 0 ? (this.contextTokens / this.modelLimit) * 100 : 0;
    }

    isActive() { return this.state !== STATE.WAITING; }

    addOrUpdateMessage(mid, cost, tokens, modelID, providerID, completedAt, createdAt) {
        if (!mid) return;
        const ex = this._messageMap.get(mid);
        if (ex) {
            this._cost -= ex.cost;
            this._tokens.input -= ex.tok.input;
            this._tokens.output -= ex.tok.output;
            this._tokens.reasoning -= ex.tok.reasoning;
            this._tokens.cache.read -= ex.tok.cache.read;
            this._tokens.cache.write -= ex.tok.cache.write;
        }
        const nc = cost || 0;
        const nt = tokens || {};
        this._messageMap.set(mid, {
            cost: nc,
            tok: {
                input: nt.input || 0,
                output: nt.output || 0,
                reasoning: nt.reasoning || 0,
                cache: { read: nt.cache?.read || 0, write: nt.cache?.write || 0 },
            },
        });
        this._cost += nc;
        this._tokens.input += nt.input || 0;
        this._tokens.output += nt.output || 0;
        this._tokens.reasoning += nt.reasoning || 0;
        this._tokens.cache.read += nt.cache?.read || 0;
        this._tokens.cache.write += nt.cache?.write || 0;

        const sortT = completedAt || createdAt || 0;
        const ctxT = (nt.input || 0) + (nt.cache?.read || 0);
        const isCur = this._latestMessageID === mid;
        const isNew = sortT >= this._latestMessageTime;

        if (isCur) {
            this._latestMessageTime = sortT;
            this._latestContextTokens = ctxT;
        } else if (isNew && (ctxT > 0 || !this._latestMessageID)) {
            this._latestMessageTime = sortT;
            this._latestMessageID = mid;
            if (ctxT > 0) this._latestContextTokens = ctxT;
        }
        if (modelID) this.model = modelID;
        if (providerID) this.provider = providerID;
    }
}
