import {
    BlobSource,
    OpfsCache,
    inspectVfiSupport,
    isDiscSupportReport,
    openDisc,
    type DiscSupportProgress,
    type DiscSupportReport,
    type Vfi,
} from "./vendor/extract/index.ts";
import {
    assertAttachedDiscIdentity,
    assertCacheSourceIdentity,
} from "./disc-identity.ts";
import { technicalReason } from "./errors.ts";

const REPORT_CACHE = "disc-support-report.json";
const CACHE_VERSION = 1;

interface CachedReport {
    readonly v: typeof CACHE_VERSION;
    readonly sourceKey: string;
    readonly report: DiscSupportReport;
}

function parseCachedReport(value: unknown,
                           expectedSourceKey: string): CachedReport | null {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.v !== CACHE_VERSION
            || candidate.sourceKey !== expectedSourceKey
            || !isDiscSupportReport(candidate.report))
        return null;
    return {
        v: CACHE_VERSION,
        sourceKey: expectedSourceKey,
        report: candidate.report,
    };
}

export class DiscReportStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly sourceKey: string;
    private readonly serial: string | null;
    private readonly volumeId: string;
    private report: DiscSupportReport | null = null;
    private request: Promise<DiscSupportReport> | null = null;
    private cacheWarning: string | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null, sourceKey: string,
                serial: string | null, volumeId: string) {
        assertCacheSourceIdentity(cache, sourceKey);
        this.cache = cache;
        this.vfi = vfi;
        this.sourceKey = sourceKey;
        this.serial = serial;
        this.volumeId = volumeId;
    }

    hasIso(): boolean { return this.vfi !== null; }
    get persistenceWarning(): string | null { return this.cacheWarning; }

    async cached(): Promise<DiscSupportReport | null> {
        if (this.report) return this.report;
        if (!this.cache) return null;
        try {
            const raw = await this.cache.read(REPORT_CACHE);
            if (!raw) return null;
            const parsed = parseCachedReport(
                JSON.parse(new TextDecoder().decode(raw)),
                this.sourceKey,
            );
            if (!parsed
                    || parsed.report.disc.serial !== this.serial
                    || parsed.report.disc.volumeId !== this.volumeId) {
                this.cacheWarning = "the cached disc report is damaged; reconnect the ISO to rebuild it";
                return null;
            }
            this.report = parsed.report;
            return this.report;
        } catch (error) {
            this.cacheWarning = `the cached disc report is unavailable (${technicalReason(error)}); reconnect the ISO to rebuild it`;
            return null;
        }
    }

    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        assertAttachedDiscIdentity(this.sourceKey, disc.cacheKey);
        this.vfi = disc.vfi;
    }

    generate(progress: (state: DiscSupportProgress) => void,
             force = false): Promise<DiscSupportReport> {
        if (this.request) return this.request;
        if (!force && this.report) return Promise.resolve(this.report);
        const vfi = this.vfi;
        if (!vfi)
            return Promise.reject(new Error(
                "the disc report needs the original ISO; choose the same disc to continue",
            ));
        const request = inspectVfiSupport(vfi, {
            serial: this.serial,
            volumeId: this.volumeId,
        }, { progress }).then(async report => {
            this.report = report;
            if (!this.cache) return report;
            const cached: CachedReport = {
                v: CACHE_VERSION,
                sourceKey: this.sourceKey,
                report,
            };
            try {
                await this.cache.write(
                    REPORT_CACHE,
                    new TextEncoder().encode(JSON.stringify(cached)),
                );
                this.cacheWarning = null;
            } catch (error) {
                this.cacheWarning = `the report is available for this session but could not be cached (${technicalReason(error)})`;
            }
            return report;
        });
        this.request = request;
        void request.finally(() => {
            if (this.request === request) this.request = null;
        }).catch(() => {});
        return request;
    }
}
