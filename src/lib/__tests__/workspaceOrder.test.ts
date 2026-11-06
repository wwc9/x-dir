// 布局方案顺序纯函数（2026-11-06 拖动排序）
import { describe, expect, it } from "vitest";

import { moveWorkspace, orderWorkspaces } from "../workspaceOrder";

describe("orderWorkspaces", () => {
  it("表内按序在前、表外按字典序追加尾", () => {
    expect(orderWorkspaces(["b", "a", "d", "c"], ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  });
  it("order 含已删方案名被忽略；空 order 回落字典序", () => {
    expect(orderWorkspaces(["b", "a"], ["x", "b"])).toEqual(["b", "a"]);
    expect(orderWorkspaces(["b", "a"], [])).toEqual(["a", "b"]);
  });
  it("不改入参", () => {
    const names = ["a", "b"];
    orderWorkspaces(names, ["b", "a"]);
    expect(names).toEqual(["a", "b"]);
  });
});

describe("moveWorkspace", () => {
  it("前移/后移/越界", () => {
    expect(moveWorkspace(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveWorkspace(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveWorkspace(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveWorkspace(["a", "b"], -1, 0)).toEqual(["a", "b"]);
    expect(moveWorkspace(["a", "b"], 0, 9)).toEqual(["a", "b"]);
  });
});
