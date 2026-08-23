    return {
      name: "dsh-graph",
      inject: ["slots", "sessions", "connection"],
      apply(ctx) {
        appCtx = ctx;
        sessionsRt = ctx.sessions ?? null;
        connectionRt = ctx.connection ?? null;
        // workspaces 服务经 ctx.get(name) 可选查找即可取到（runner 的 ctx.get 方法不要求 inject 声明，
        // 注入门禁只拦 ctx.workspaces 属性访问；workspaces 由 client-runtime `ctx.reflect.provide` 提供）
        workspacesRt = ctx.get?.("workspaces") ?? null;
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            { name: "conversation.view", id: "dsh-graph-kanban", order: 80, label: "看板" },
            (props) => h(KanbanView, props),
          ),
        );
        console.log("[dsh-graph-host] client apply: kanban view registered");
      },
    };
  },
});

