// Whale channel registry: the service every channel adapter (and the gateway)
// shares. A channel is a small object exposing `send`, optional
// `parseInbound`, optional `start`/`stop`, and a status label. New channels
// register here; the gateway routes inbound messages to the agent and replies
// through the channel's `send`.
const name = "whale-channels";

/** Service name provided by this plugin and injected by adapters + gateway. */
export const WHALE_CHANNELS_SERVICE = "whaleChannels";

function apply(ctx) {
	const channels = new Map();
	ctx.provide(WHALE_CHANNELS_SERVICE, {
		register(channel) {
			if (channels.has(channel.id)) throw new Error(`whale: channel ${channel.id} is already registered`);
			channels.set(channel.id, channel);
			return () => channels.delete(channel.id);
		},
		get(id) {
			return channels.get(id);
		},
		list() {
			return [...channels.values()];
		}
	});
}

export { apply, name };
