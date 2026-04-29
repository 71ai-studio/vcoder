import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@vcoder/core/global"
import { InstallationChannel } from "@vcoder/core/installation/version"
import { Database } from "@/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta"].includes(InstallationChannel)
      ? path.join(Global.Path.data, "vcoder.db")
      : path.join(Global.Path.data, `vcoder-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })
})
