/** 两条消息之间隔多久就补一个时间戳（微信式：隔久了再说话会显示时刻）。 */
export const PROACTIVE_GAP_MS = 10 * 60 * 1000;

/** 发出去的占位气泡 20 秒没被认领就撤掉（宁可不显示，不留对不上号的话）。 */
export const PENDING_TTL_MS = 20_000;

/** 轮询间隔与处理单监控上限。 */
export const PULL_INTERVAL_MS = 2500;
/** 连续空轮询的退避档：第 1/2 拍起分别拉到 5s/10s 封顶。 */
export const PULL_IDLE_STEPS = [5000, 10000];
export const TURN_WATCH_MAX_TRIES = 300;
/**
 * 一轮在飞时，处理单每 900ms 拍一次，而消息列表每几拍拉一次。
 * 草稿走 /api/turn 那一拍，不靠消息列表；消息最快也是分条那 450ms 一条，
 * 所以两拍（1.8s）足够——在飞时的请求数从 ~2.4/s 降到 ~1.7/s。
 * 觉得分条节奏塌了就改回 1（代价回到原来的请求数）。
 */
export const WATCH_PULL_EVERY = 2;
