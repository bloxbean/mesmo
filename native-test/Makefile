NATIVE_DIR ?= ../core/build/native/nativeCompile
CC ?= cc
CFLAGS = -I$(NATIVE_DIR)
LDFLAGS = -L$(NATIVE_DIR) -lmesmo -Wl,-rpath,$(NATIVE_DIR)

.PHONY: all clean test

all: test_mesmo

test_mesmo: src/test_mesmo.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

test: test_mesmo
	DYLD_LIBRARY_PATH=$(NATIVE_DIR) LD_LIBRARY_PATH=$(NATIVE_DIR) ./test_mesmo

clean:
	rm -f test_mesmo
