const params = new URLSearchParams(location.search);

if (params.has("viewer")) {
    void import("./viewer.ts").then(({ startViewer }) => startViewer());
} else {
    void import("./main.ts");
}
