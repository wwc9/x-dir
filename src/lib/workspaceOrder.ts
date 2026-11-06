// 布局方案显示顺序（2026-11-06 拖动排序）纯函数：list_workspaces 返回按
// 文件名字典序；用户拖动自定顺序持久化在 settings.workspaceOrder——
// 渲染时按 order 重排，不在表中的新方案（新建/导入）按字典序追加尾部。

/** 按 order 重排（不改入参）：表内按序在前，表外按字典序追加尾；
 *  order 中已不存在的名字被忽略（方案删除后自然失效） */
export function orderWorkspaces(
  names: readonly string[],
  order: readonly string[],
): string[] {
  const pos = new Map(order.map((n, i) => [n, i]));
  const inOrder: { n: string; i: number }[] = [];
  const rest: string[] = [];
  for (const n of names) {
    const i = pos.get(n);
    if (i === undefined) rest.push(n);
    else inOrder.push({ n, i });
  }
  inOrder.sort((a, b) => a.i - b.i);
  rest.sort();
  return [...inOrder.map((x) => x.n), ...rest];
}

/** 拖动落位后的新 order（把 from 移到 to 的位置，其余顺移）；
 *  返回全量方案名序列的顺序，直接存 settings.workspaceOrder */
export function moveWorkspace(
  ordered: readonly string[],
  from: number,
  to: number,
): string[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= ordered.length ||
    to >= ordered.length
  ) {
    return [...ordered];
  }
  const out = [...ordered];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
