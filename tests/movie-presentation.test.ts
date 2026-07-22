import assert from "node:assert/strict";
import { test } from "node:test";

import {
    formatMovieBytes,
    movieGroupLabel,
    movieScanLabel,
    movieSourceComplete,
} from "../src/movie-presentation.ts";
import type { MovieCacheInfo, MovieEntry, MovieGroup } from "../src/movies.ts";

function entry(fieldOrder: MovieEntry["video"]["fieldOrder"] = "progressive",
               group: MovieGroup = "opening"): MovieEntry {
    return {
        name: "new_example",
        label: "Example",
        group,
        movie: {
            entryOff: 0,
            entrySize: 0,
            parentOff: 0,
            sector: 10,
            size: 1000,
            name: "new_example.str",
            path: "debug/us/movie/new_example.str",
        },
        subtitleBin: {
            entryOff: 0,
            entrySize: 0,
            parentOff: 0,
            sector: 20,
            size: 100,
            name: "new_example.bin",
            path: "debug/us/movie/new_example.bin",
        },
        subtitleSbt: {
            entryOff: 0,
            entrySize: 0,
            parentOff: 0,
            sector: 21,
            size: 200,
            name: "new_example.sbt",
            path: "debug/us/movie/new_example.sbt",
        },
        sourceBytes: 1000,
        subtitleBytes: 300,
        subtitleCues: 2,
        subtitleEnd: 3.5,
        header: {
            fields: 60,
            fieldRate: 29.97,
            groups: 1,
            sampleRate: 48000,
            channels: 2,
            interleave: 2048,
            audioBlock: 4096,
            preload: 8192,
            audioBytes: 16384,
        },
        video: {
            width: 512,
            height: 320,
            frameRate: fieldOrder === "progressive" ? 29.97 : 59.94,
            fieldOrder,
            sampleAspect: [7, 6],
            displayAspect: [28, 15],
        },
        duration: 2,
    };
}

test("movie scan labels preserve field order in detailed and compact forms", () => {
    assert.equal(movieScanLabel(entry("progressive"), true), "Progressive · 29.97 fps");
    assert.equal(movieScanLabel(entry("tt"), true), "Top field first · bobbed to 59.94 fps");
    assert.equal(movieScanLabel(entry("bb"), true), "Bottom field first · bobbed to 59.94 fps");
    assert.equal(movieScanLabel(entry("progressive"), false), "29.97p");
    assert.equal(movieScanLabel(entry("tt"), false), "59.94p · source TFF");
    assert.equal(movieScanLabel(entry("bb"), false), "59.94p · source BFF");
});

test("movie byte labels use binary unit thresholds", () => {
    assert.equal(formatMovieBytes(0), "0 B");
    assert.equal(formatMovieBytes(1023), "1023 B");
    assert.equal(formatMovieBytes(1024), "1.0 KiB");
    assert.equal(formatMovieBytes(1024 ** 2 - 1), "1024.0 KiB");
    assert.equal(formatMovieBytes(1024 ** 2), "1.0 MiB");
    assert.equal(formatMovieBytes(1024 ** 3), "1.00 GiB");
});

test("movie group labels describe all catalog groups", () => {
    assert.equal(movieGroupLabel(entry("progressive", "opening")), "Station IDs & openings");
    assert.equal(movieGroupLabel(entry("progressive", "story")), "Story scenes");
    assert.equal(movieGroupLabel(entry("progressive", "gameplay")), "Gameplay reels");
});

test("complete source cache requires str and both subtitle sidecars", () => {
    const incomplete: MovieCacheInfo = {
        sourceBytes: 1299,
        exportBytes: 0,
        totalBytes: 1299,
    };
    const complete: MovieCacheInfo = {
        sourceBytes: 1300,
        exportBytes: 0,
        totalBytes: 1300,
    };
    assert.equal(movieSourceComplete(entry(), incomplete), false);
    assert.equal(movieSourceComplete(entry(), complete), true);
});
