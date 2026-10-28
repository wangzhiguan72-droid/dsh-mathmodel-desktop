// Source excerpt: @linxin666/dsh-client-ui-git-graph@0.3.23/lib/client.js, auto-isolation region.
// Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0.
		//#region src/client/auto-isolation.ts
		/** Log line prefix for every auto-isolation diagnostic. */
		const TAG = "[git-graph] auto-isolation";
		/**
		* Probe the workspaces service shape: the wrapper only installs when every
		* member it shadows or calls is a function of the expected kind. A changed
		* client-runtime surface leaves the official behavior untouched.
		*/
		function probeWorkspaces(value) {
			if (typeof value !== "object" || value === null) return null;
			const candidate = value;
			if (typeof candidate.startSession !== "function" || typeof candidate.create !== "function" || typeof candidate.connectWorkspace !== "function" || typeof candidate.list?.getSnapshot !== "function") return null;
			return candidate;
		}
		/**
		* Install the startSession wrapper on the shared workspaces service.
		* @param scope - client context carrying workspaces and sessions.
		* @param git - the /git/* client (config + worktree verbs).
		* @returns the disposer restoring the official method.
		*/
		function installAutoIsolation(scope, git) {
			const workspaces = probeWorkspaces(scope.workspaces);
			if (workspaces === null) {
				console.warn(`${TAG} disabled: the workspaces service shape changed; using the official new-session behavior`);
				return () => {};
			}
			let original;
			try {
				original = workspaces.startSession;
			} catch {
				console.warn(`${TAG} disabled: startSession is not readable`);
				return () => {};
			}
			/** The official target resolution (explicit > current session's workspace > recent). */
			const resolveTarget = (workspaceId) => {
				const snapshot = workspaces.list.getSnapshot();
				const current = scope.sessions.list.getSnapshot().current;
				const currentWorkspaceId = current === void 0 ? void 0 : snapshot.items.find((item) => item.sessionIds.includes(current))?.workspaceId;
				return workspaceId ?? currentWorkspaceId ?? snapshot.recentWorkspaceId;
			};
			/**
			* Targets with a routing flow already in flight. The new-session button
			* fires `startSession` on every click and nothing upstream debounces it, so
			* a fast double click would otherwise run two isolation flows and create two
			* worktrees; the second click is absorbed while the first is routing.
			*/
			const routing = /* @__PURE__ */ new Set();
			const routed = (workspaceId) => {
				const target = resolveTarget(workspaceId);
				if (target === void 0) {
					original.call(workspaces);
					return;
				}
				if (routing.has(target)) return;
				routing.add(target);
				(async () => {
					const configResult = await git.config();
					if (!configResult.ok || !configResult.value.autoIsolate) {
						original.call(workspaces, target);
						return;
					}
					const config = configResult.value;
					const item = workspaces.list.getSnapshot().items.find((entry) => entry.workspaceId === target);
					if (item === void 0) {
						original.call(workspaces, target);
						return;
					}
					const home = config.worktreesHome;
					if (item.path.startsWith(home + "/") || item.path.startsWith(home + "\\")) {
						original.call(workspaces, target);
						return;
					}
					const status = await git.status(item.path);
					if (!status.ok || status.value === null) {
						original.call(workspaces, target);
						return;
					}
					const name = `s-${Date.now().toString(36)}`;
					const baseRef = config.autoBaseline === "default" ? "origin/HEAD" : void 0;
					const created = await git.addWorktree(item.path, name, baseRef);
					if (!created.ok) {
						console.warn(`${TAG} worktree creation failed; starting the session in the main checkout instead`, created.error);
						original.call(workspaces, target);
						return;
					}
					let registeredId;
					try {
						const workspace = await workspaces.create({ path: created.value.path });
						registeredId = workspace.workspaceId;
						original.call(workspaces, workspace.workspaceId);
					} catch (error) {
						if (registeredId !== void 0 && typeof workspaces.delete === "function") try {
							await workspaces.delete(registeredId);
						} catch (cleanupError) {
							console.warn(`${TAG} could not drop the failed workspace registration`, cleanupError);
						}
						await git.removeWorktree(item.path, created.value.path, { force: true });
						console.warn(`${TAG} workspace registration failed; rolled back the worktree`, error);
						original.call(workspaces, target);
					}
				})().catch((error) => {
					console.warn(`${TAG} routing failed; using the official behavior`, error);
					original.call(workspaces, target);
				}).finally(() => {
					routing.delete(target);
				});
			};
			try {
				workspaces.startSession = routed;
			} catch {
				console.warn(`${TAG} disabled: startSession is not writable`);
				return () => {};
			}
			return () => {
				try {
					workspaces.startSession = original;
				} catch {}
			};
		}
		//#endregion
ctx.inject(["workspaces", "sessions"], (worktreeScope) => {
