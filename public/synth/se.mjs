/* Embedded-SE bank inspection through the public synth API. Pure module: the
 * export worker and Node gates drive the same implementation. */
import { AE3Synth } from "./ae3synth.mjs";

/** Return request counts by outer bank index. Zero marks an absent slot. */
export async function inspectSeBank(wasmSource, files) {
    const synth = await AE3Synth.instantiate(wasmSource);
    try {
        synth.loadBank(files.hd, files.bd);
        const banks = synth.seBanks();
        const requests = new Uint16Array(banks);
        for (let bank = 0; bank < banks; bank++)
            requests[bank] = synth.seRequests(bank);
        return requests;
    } finally {
        synth.dispose();
    }
}
