-- ChatGPT Persona Voice - WirePlumber 0.5+ pre-link and crash recovery policy

local lutils = require("linking-utils")
local log = Log.open_topic("s-cpv-policy")
local ingress_prefix = "chatgpt-persona-voice.ingress."
local bypass_prefix = "chatgpt-persona-voice.bypass."
local routes = Conf.get_section_as_json(
    "chatgpt_persona_voice.identities", Json.Array {}):parse(2)

local function playback_route(properties)
  if properties["media.class"] ~= "Stream/Output/Audio" then
    return nil
  end
  local probe = properties["chatgpt.persona.voice.policy-probe"]
  if probe ~= nil and tostring(probe) ~= "" and tostring(probe) ~= "false" then
    return tostring(probe)
  end
  for _, identity in ipairs(routes) do
    if properties[identity.property] == identity.value then
      return identity.route
    end
  end
  return nil
end

SimpleEventHook {
  name = "chatgpt-persona-voice/select-ingress",
  before = "linking/find-defined-target",
  interests = {
    EventInterest {
      Constraint { "event.type", "=", "select-target" },
    },
  },
  execute = function(event)
    local _, object_manager, session_item, properties, _, target =
        lutils:unwrap_select_target_event(event)
    local route = playback_route(properties)
    if target or not route then return end

    local ingress = object_manager:lookup {
      type = "SiLinkable",
      Constraint { "node.name", "=", ingress_prefix .. route },
      Constraint { "item.node.direction", "=", "input" },
    }
    if not ingress or not lutils.canLink(properties, ingress) then
      log:critical(session_item,
          "Persona ingress is unavailable; refusing physical fallback")
      event:stop_processing()
      return
    end
    event:set_data("target", ingress)
  end,
}:register()

-- Keep suppression coupled to the lifetime of the native capture node. The
-- object-removed event is delivered even when the helper is killed, restoring
-- the bypass without relying on application cleanup code.
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
