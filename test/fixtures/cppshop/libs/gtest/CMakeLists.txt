# Built as its own library; its folder is an include root for the users.
add_library(gtest STATIC gtest/gtest.h)
# include_directories(commented/out)
target_include_directories(gtest SYSTEM PUBLIC .)
