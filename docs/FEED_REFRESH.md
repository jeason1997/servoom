# Community feed refresh

Verified against the installed Android app 3.8.36 and the live community service on 2026-11-02.

The gallery refresh handler increments its refresh counter, resets StartNum to 1 and EndNum to the page size, and sends RefreshIndex on GetCategoryFileListV2. Subsequent pagination retains that refresh counter. Requests also include the signed-in account Token and UserId.

Anonymous tests with category 18 and FileSize 1 returned identical artwork IDs for RefreshIndex 0, 1 and 2. In the signed-in local gallery, consecutive refreshes using incrementing indices returned different artwork lists. Therefore an anonymous-only test is insufficient to determine whether RefreshIndex works.

The web implementation follows this behavior without shuffling results locally. Changing the filter resets the counter; refreshing the same filter increments it. Credentials and response dumps are not included in this document.
