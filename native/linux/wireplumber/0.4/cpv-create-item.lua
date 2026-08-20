-- ChatGPT Persona Voice - WirePlumber 0.4 session-item creation policy
-- Derived from WirePlumber 0.4.17 src/scripts/create-item.lua
-- Copyright 2021 Collabora Ltd.; modified by ChatGPT Persona Voice contributors
-- SPDX-License-Identifier: MIT
--
-- WirePlumber 0.4 has no ordered select-target hook API. This file is the
-- upstream 0.4 create-item policy with one deliberate addition: matching
-- playback nodes receive an immutable, no-reconnect target before their
-- SessionItem is registered. The 0.4 loader installs this instead of the
-- stock create-item.lua; every other behavior remains upstream-equivalent.

local config = ... or {}
local ingress_prefix = "chatgpt-persona-voice.ingress."
local bypass_prefix = "chatgpt-persona-voice.bypass."
local routes = config["chatgpt-persona-voice.identities"] or {}

items = {}

local function playback_route(np)
  if np["media.class"] ~= "Stream/Output/Audio" then
    return nil
  end
  local probe = np["chatgpt.persona.voice.policy-probe"]
  if probe ~= nil and tostring(probe) ~= "" and tostring(probe) ~= "false" then
    return tostring(probe)
  end
  for _, identity in ipairs(routes) do
    if np[identity.property] == identity.value then
      return identity.route
    end
  end
  return nil
end

function configProperties(node)
  local np = node.properties
  local properties = {
    ["item.node"] = node,
    ["item.plugged.usec"] = GLib.get_monotonic_time(),
    ["item.features.no-dsp"] = config["audio.no-dsp"],
    ["item.features.monitor"] = true,
    ["item.features.control-port"] = false,
    ["node.id"] = node["bound-id"],
    ["client.id"] = np["client.id"],
    ["object.path"] = np["object.path"],
    ["object.serial"] = np["object.serial"],
    ["target.object"] = np["target.object"],
    ["priority.session"] = np["priority.session"],
    ["device.id"] = np["device.id"],
    ["card.profile.device"] = np["card.profile.device"],
    ["target.endpoint"] = np["target.endpoint"],
  }

  for key, value in pairs(np) do
    if key:find("^node") or key:find("^stream") or key:find("^media") then
      properties[key] = value
    end
  end

  local media_class = properties["media.class"] or ""
  if not properties["media.type"] then
    for _, media_type in ipairs({ "Audio", "Video", "Midi" }) do
      if media_class:find(media_type) then
        properties["media.type"] = media_type
        break
      end
    end
  end

  properties["item.node.type"] =
      media_class:find("^Stream/") and "stream" or "device"
  if media_class:find("Sink") or media_class:find("Input") or
      media_class:find("Duplex") then
    properties["item.node.direction"] = "input"
  elseif media_class:find("Source") or media_class:find("Output") then
    properties["item.node.direction"] = "output"
  end

  local route = playback_route(np)
  if route then
    properties["target.object"] = ingress_prefix .. route
    properties["node.dont-reconnect"] = "true"
    properties["node.dont-move"] = "true"
    properties["node.dont-fallback"] = "true"
    properties["chatgpt.persona.voice.policy"] = "2"
    properties["chatgpt.persona.voice.route"] = route
  end
  return properties
end

function addItem(node, item_type)
  local id = node["bound-id"]
  local item = SessionItem(item_type)
  items[id] = item
  if not item:configure(configProperties(node)) then
    Log.warning(item, "failed to configure item for node " .. tostring(id))
    return
  end
  item:register()
  items[id]:activate(Features.ALL, function(active_item, error)
    if error then
      Log.message(active_item, "failed to activate item: " .. tostring(error))
      if active_item then
        active_item:remove()
      end
    else
      Log.info(active_item, "activated item for node " .. tostring(id))
      active_item:remove()
      if active_item["active-features"] ~= 0 then
        active_item:register()
      end
    end
  end)
end

nodes_om = ObjectManager {
  Interest {
    type = "node",
    Constraint { "media.class", "#", "Stream/*", type = "pw-global" },
  },
  Interest {
    type = "node",
    Constraint { "media.class", "#", "Video/*", type = "pw-global" },
  },
  Interest {
    type = "node",
    Constraint { "media.class", "#", "Audio/*", type = "pw-global" },
    Constraint { "wireplumber.is-endpoint", "-", type = "pw" },
  },
}

nodes_om:connect("object-added", function(_, node)
  local media_class = node.properties["media.class"]
  if string.find(media_class, "Audio") then
    addItem(node, "si-audio-adapter")
  else
    addItem(node, "si-node")
  end
end)

nodes_om:connect("object-removed", function(_, node)
  local id = node["bound-id"]
  if items[id] then
    items[id]:remove()
    items[id] = nil
  end
end)

nodes_om:activate()

-- The bypass mute is also policy-owned. A guard node is created by the native
-- capture helper; removing that node (including SIGKILL or parent death)
-- unconditionally unmutes the bypass, so suppression cannot outlive its owner.
local bypasses = {}
local guards = {}
local guard_counts = {}

local function apply_bypass_mute(route)
  local bypass = bypasses[route]
  if not bypass then return end
  bypass:set_param("Props", Pod.Object {
    "Spa:Pod:Object:Param:Props", "Props",
    mute = (guard_counts[route] or 0) > 0,
  })
end

guard_om = ObjectManager {
  Interest {
    type = "node",
    Constraint { "node.name", "#", bypass_prefix .. "*", type = "pw-global" },
  },
  Interest {
    type = "node",
    Constraint { "media.class", "=", "Stream/Input/Audio", type = "pw-global" },
  },
}

guard_om:connect("object-added", function(_, node)
  local name = node.properties["node.name"] or ""
  if string.sub(name, 1, string.len(bypass_prefix)) == bypass_prefix then
    local route = string.sub(name, string.len(bypass_prefix) + 1)
    bypasses[route] = node
    apply_bypass_mute(route)
  elseif tostring(node.properties["chatgpt.persona.voice.capture-guard"]) == "true" then
    local route = tostring(node.properties["chatgpt.persona.voice.route"] or "")
    if route ~= "" then
      guards[node["bound-id"]] = route
      guard_counts[route] = (guard_counts[route] or 0) + 1
      apply_bypass_mute(route)
    end
  end
end)

guard_om:connect("object-removed", function(_, node)
  local name = node.properties["node.name"] or ""
  if string.sub(name, 1, string.len(bypass_prefix)) == bypass_prefix then
    local route = string.sub(name, string.len(bypass_prefix) + 1)
    if bypasses[route] == node then bypasses[route] = nil end
  end
  local route = guards[node["bound-id"]]
  if route then
    guards[node["bound-id"]] = nil
    guard_counts[route] = math.max(0, (guard_counts[route] or 1) - 1)
    apply_bypass_mute(route)
  end
end)

guard_om:activate()
