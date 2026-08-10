export interface DiscOpenTicket {
    readonly generation: number;
    readonly signal: AbortSignal;
}

/** One generation shared by startup resume and every explicit disc open. */
export class DiscOpenCoordinator {
    private generation = 0;
    private controller: AbortController | null = null;

    begin(): DiscOpenTicket {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        return {
            generation: ++this.generation,
            signal: controller.signal,
        };
    }

    isCurrent(ticket: DiscOpenTicket): boolean {
        return ticket.generation === this.generation && !ticket.signal.aborted;
    }

    complete(ticket: DiscOpenTicket): void {
        if (this.isCurrent(ticket)) this.controller = null;
    }
}

/** Serializes teardown so a superseding open cannot bypass older cleanup. */
export class SerializedDiscCleanup {
    private tail: Promise<void> = Promise.resolve();

    run(operation: () => Promise<void>): Promise<void> {
        const result = this.tail.then(operation);
        /* The caller still receives `result`; the queue tail is settled so a
         * reported cleanup failure cannot strand every future reset. */
        this.tail = result.catch(error => {
            console.error("disc cleanup failed", error);
        });
        return result;
    }
}
