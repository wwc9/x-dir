import { Fragment, useCallback } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import type { LayoutNode } from "../lib/layoutTree";
import { useLayout } from "../stores/layout";
import { Pane } from "./Pane";

function NodeView({ node }: { node: LayoutNode }) {
  const onLayoutChanged = useCallback(
    (layout: { [panelId: string]: number }) => {
      if (node.type !== "split") return;
      const sizes = node.children.map(
        (c) => layout[c.id] ?? 100 / node.children.length,
      );
      // 与现值一致时跳过（同对齐组其他列 setLayout 后的回声，防循环）
      if (
        node.sizes &&
        node.sizes.length === sizes.length &&
        node.sizes.every((s, i) => Math.abs(s - sizes[i]) < 0.01)
      ) {
        return;
      }
      // 松手后才写回 store：store 会经命令式 setLayout 同步同对齐组
      // 的其他列（拖拽进行中 setLayout 会打断拖拽，故不能在拖拽中同步）
      useLayout.getState().setSizes(node.id, sizes);
    },
    [node],
  );

  if (node.type === "pane") return <Pane pane={node} />;
  return (
    <Group
      orientation={node.dir === "horizontal" ? "horizontal" : "vertical"}
      className="!min-h-0"
      onLayoutChanged={onLayoutChanged}
    >
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && (
            <Separator
              className={`np-separator ${
                node.dir === "horizontal" ? "np-sep-v" : "np-sep-h"
              }`}
              onDoubleClick={() =>
                useLayout
                  .getState()
                  .setSizes(
                    node.id,
                    node.children.map(() => 100 / node.children.length),
                  )
              }
            />
          )}
          <Panel
            id={c.id}
            defaultSize={node.sizes?.[i] ?? 100 / node.children.length}
            minSize={8}
          >
            <NodeView node={c} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

export function LayoutView({ node }: { node: LayoutNode }) {
  return <NodeView node={node} />;
}
