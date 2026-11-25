CREATE TABLE app.devices (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

CREATE TABLE app.device_bindings (
  id uuid PRIMARY KEY,
  host_device_id uuid NOT NULL REFERENCES app.devices(id),
  controller_device_id uuid NOT NULL REFERENCES app.devices(id),
  host_name text NOT NULL,
  controller_name text NOT NULL,
  active_room_code text,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (host_device_id, controller_device_id)
);

CREATE TABLE app.device_pair_codes (
  code text PRIMARY KEY,
  host_device_id uuid NOT NULL REFERENCES app.devices(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX devices_last_seen_idx ON app.devices (last_seen_at);
CREATE INDEX device_bindings_host_idx ON app.device_bindings (host_device_id);
CREATE INDEX device_bindings_controller_idx ON app.device_bindings (controller_device_id);
CREATE INDEX device_bindings_active_room_idx ON app.device_bindings (active_room_code);
CREATE INDEX device_pair_codes_host_idx ON app.device_pair_codes (host_device_id);
CREATE INDEX device_pair_codes_expires_idx ON app.device_pair_codes (expires_at);
