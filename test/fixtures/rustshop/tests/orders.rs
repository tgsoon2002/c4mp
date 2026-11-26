fn make_total(n: u32) -> u32 {
    n * 2
}

#[test]
fn total_doubles() {
    assert_eq!(make_total(2), 4);
}

/// Runs on the async runtime.
#[tokio::test(flavor = "multi_thread")]
async fn total_async() {
    assert_eq!(make_total(1), 2);
}

#[test]
#[should_panic]
fn total_overflows() {
    make_total(u32::MAX);
}
