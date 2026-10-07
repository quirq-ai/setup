// Preloaded with node --import so the real CLI runs as it would on a Mac (CI's e2e runs on Linux).
Object.defineProperty(process, "platform", { value: "darwin" });
