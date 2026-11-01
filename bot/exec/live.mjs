/** 實盤介面。一律 throw「實盤未開放」。 */
export function placeOrder() {
  throw new Error("實盤未開放");
}
export function cancelOrder() {
  throw new Error("實盤未開放");
}
export function getBalance() {
  throw new Error("實盤未開放");
}
