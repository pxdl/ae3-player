import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMovieBytes } from "../src/movie-presentation.ts";


test("movie byte labels use binary unit thresholds", () => {
    assert.equal(formatMovieBytes(0), "0 B");
    assert.equal(formatMovieBytes(1023), "1023 B");
    assert.equal(formatMovieBytes(1024), "1.0 KiB");
    assert.equal(formatMovieBytes(1024 ** 2 - 1), "1024.0 KiB");
    assert.equal(formatMovieBytes(1024 ** 2), "1.0 MiB");
    assert.equal(formatMovieBytes(1024 ** 3), "1.00 GiB");
});

