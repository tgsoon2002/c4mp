#pragma once

namespace shop {

inline int clampId(int id) { return id < 0 ? 0 : id; }

}  // namespace shop
