#!/usr/bin/env python3
"""
Test suite for clean_data.py - DumpsterMap data cleaning pipeline
Tests cover: should_remove, normalize_phone, normalize_address, deduplicate, calculate_quality_score
"""

import pytest
import sys
from pathlib import Path

# Add scripts directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from clean_data import (
    should_remove, normalize_phone, normalize_address,
    deduplicate, calculate_quality_score,
    BIG_BOX_RETAILERS, NATIONAL_WASTE_COMPANIES,
    JUNK_REMOVAL_ONLY_KEYWORDS, NON_DUMPSTER_KEYWORDS
)


# =============================================================================
# Constants Tests
# =============================================================================

class TestConstants:
    """Test that constant lists have expected entries."""
    
    def test_big_box_retailers_not_empty(self):
        assert len(BIG_BOX_RETAILERS) > 0
        
    def test_big_box_retailers_includes_home_depot(self):
        assert "home depot" in BIG_BOX_RETAILERS
        
    def test_big_box_retailers_includes_lowes(self):
        assert any("lowe" in r for r in BIG_BOX_RETAILERS)
        
    def test_national_waste_companies_not_empty(self):
        assert len(NATIONAL_WASTE_COMPANIES) > 0
        
    def test_national_waste_companies_includes_waste_management(self):
        assert "waste management" in NATIONAL_WASTE_COMPANIES
        
    def test_national_waste_companies_includes_republic(self):
        assert "republic services" in NATIONAL_WASTE_COMPANIES
        
    def test_junk_removal_keywords_not_empty(self):
        assert len(JUNK_REMOVAL_ONLY_KEYWORDS) > 0
        
    def test_non_dumpster_keywords_not_empty(self):
        assert len(NON_DUMPSTER_KEYWORDS) > 0
        
    def test_non_dumpster_includes_portable_toilet(self):
        assert "portable toilet" in NON_DUMPSTER_KEYWORDS
        
    def test_non_dumpster_includes_storage(self):
        assert any("storage" in kw for kw in NON_DUMPSTER_KEYWORDS)


# =============================================================================
# normalize_phone Tests
# =============================================================================

class TestNormalizePhone:
    """Test phone number normalization."""
    
    def test_normalize_standard_10_digit(self):
        assert normalize_phone("555-123-4567") == "5551234567"
        
    def test_normalize_with_parentheses(self):
        assert normalize_phone("(555) 123-4567") == "5551234567"
        
    def test_normalize_with_country_code(self):
        assert normalize_phone("1-555-123-4567") == "5551234567"
        
    def test_normalize_with_plus_country_code(self):
        assert normalize_phone("+1 555 123 4567") == "5551234567"
        
    def test_normalize_plain_digits(self):
        assert normalize_phone("5551234567") == "5551234567"
        
    def test_normalize_with_dots(self):
        assert normalize_phone("555.123.4567") == "5551234567"
        
    def test_normalize_empty_string(self):
        assert normalize_phone("") == ""
        
    def test_normalize_none(self):
        assert normalize_phone(None) == ""
        
    def test_normalize_with_extension(self):
        # Extension stripped out
        result = normalize_phone("555-123-4567 ext 123")
        assert result == "55512345671233" or result.startswith("5551234567")


# =============================================================================
# normalize_address Tests
# =============================================================================

class TestNormalizeAddress:
    """Test address normalization."""
    
    def test_normalize_street_to_full(self):
        result = normalize_address("123 Main St")
        assert "street" in result
        
    def test_normalize_road_to_full(self):
        result = normalize_address("456 Oak Rd")
        assert "road" in result
        
    def test_normalize_avenue_to_full(self):
        result = normalize_address("789 Park Ave")
        assert "avenue" in result
        
    def test_normalize_boulevard_to_full(self):
        result = normalize_address("101 Ocean Blvd")
        assert "boulevard" in result
        
    def test_normalize_drive_to_full(self):
        result = normalize_address("222 Sunset Dr")
        assert "drive" in result
        
    def test_normalize_lowercase(self):
        result = normalize_address("123 MAIN STREET")
        assert result == result.lower()
        
    def test_normalize_removes_extra_spaces(self):
        result = normalize_address("123   Main   Street")
        assert "  " not in result
        
    def test_normalize_empty_string(self):
        assert normalize_address("") == ""
        
    def test_normalize_none(self):
        assert normalize_address(None) == ""
        
    def test_normalize_strips_whitespace(self):
        result = normalize_address("  123 Main St  ")
        assert not result.startswith(" ")
        assert not result.endswith(" ")


# =============================================================================
# should_remove Tests
# =============================================================================

class TestShouldRemove:
    """Test record filtering logic."""
    
    # Valid records that should be kept
    def test_keep_valid_dumpster_company(self):
        record = {
            "name": "ABC Dumpster Rental",
            "phone": "555-123-4567",
            "address": "123 Main St, Naples, FL"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is False
        assert reason == "keep"
        
    def test_keep_with_website_only(self):
        record = {
            "name": "XYZ Containers",
            "website": "https://xyzcontainers.com",
            "address": "456 Oak Ave"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is False
        
    # Missing critical fields
    def test_remove_missing_name(self):
        record = {"phone": "555-123-4567", "address": "123 Main St"}
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert reason == "missing_name"
        
    def test_remove_empty_name(self):
        record = {"name": "", "phone": "555-123-4567", "address": "123 Main St"}
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert reason == "missing_name"
        
    def test_remove_missing_contact(self):
        record = {"name": "ABC Company", "address": "123 Main St"}
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert reason == "missing_contact"
        
    def test_remove_missing_address(self):
        record = {"name": "ABC Company", "phone": "555-123-4567"}
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert reason == "missing_address"
        
    # Permanently closed
    def test_remove_closed_permanently(self):
        record = {
            "name": "Closed Dumpsters Inc",
            "phone": "555-123-4567",
            "address": "123 Main St",
            "business_status": "CLOSED_PERMANENTLY"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert reason == "closed_permanently"
        
    def test_keep_operational_status(self):
        record = {
            "name": "Active Dumpsters",
            "phone": "555-123-4567",
            "address": "123 Main St",
            "business_status": "OPERATIONAL"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is False
        
    # Big box retailers
    def test_remove_home_depot(self):
        record = {
            "name": "Home Depot Tool Rental",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert "big_box_retailer" in reason
        
    def test_remove_lowes(self):
        record = {
            "name": "Lowe's Equipment Rental",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert "big_box_retailer" in reason
        
    # National waste companies
    def test_remove_waste_management(self):
        record = {
            "name": "Waste Management of Florida",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert "national_chain" in reason
        
    def test_remove_republic_services(self):
        record = {
            "name": "Republic Services Inc",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert "national_chain" in reason
        
    # Non-dumpster keywords
    def test_remove_portable_toilet(self):
        record = {
            "name": "ABC Portable Toilet Rentals",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert "non_dumpster" in reason
        
    def test_remove_storage_units(self):
        record = {
            "name": "Self Storage Center",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert "non_dumpster" in reason
        
    def test_remove_moving_company(self):
        record = {
            "name": "ABC Moving Company",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        assert "non_dumpster" in reason
        
    # Case insensitivity
    def test_remove_case_insensitive_name(self):
        record = {
            "name": "HOME DEPOT RENTAL",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        
    def test_remove_case_insensitive_category(self):
        record = {
            "name": "ABC Services",
            "phone": "555-123-4567",
            "address": "123 Main St",
            "category": "Portable Toilet Rental"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True


# =============================================================================
# calculate_quality_score Tests
# =============================================================================

class TestCalculateQualityScore:
    """Test quality score calculation."""
    
    def test_score_returns_float(self):
        record = {"name": "Test"}
        score = calculate_quality_score(record)
        assert isinstance(score, float)
        
    def test_score_between_0_and_1(self):
        record = {"name": "Test"}
        score = calculate_quality_score(record)
        assert 0 <= score <= 1
        
    def test_empty_record_low_score(self):
        record = {}
        score = calculate_quality_score(record)
        assert score < 0.3
        
    def test_complete_record_higher_score(self):
        record = {
            "name": "ABC Dumpster Rental",
            "phone": "555-123-4567",
            "address": "123 Main St",
            "website": "https://abc.com",
            "verified": True,
            "business_status": "OPERATIONAL",
            "reviews": 100,
            "rating": 4.8,
            "photos_count": 15
        }
        score = calculate_quality_score(record)
        assert score > 0.8
        
    def test_high_reviews_boost_score(self):
        low_reviews = {"name": "Test", "reviews": 0}
        high_reviews = {"name": "Test", "reviews": 100}
        assert calculate_quality_score(high_reviews) > calculate_quality_score(low_reviews)
        
    def test_high_rating_boost_score(self):
        low_rating = {"name": "Test", "rating": 2.0}
        high_rating = {"name": "Test", "rating": 5.0}
        assert calculate_quality_score(high_rating) > calculate_quality_score(low_rating)
        
    def test_verified_boosts_score(self):
        unverified = {"name": "Test", "verified": False}
        verified = {"name": "Test", "verified": True}
        assert calculate_quality_score(verified) > calculate_quality_score(unverified)
        
    def test_photos_boost_score(self):
        no_photos = {"name": "Test", "photos_count": 0}
        many_photos = {"name": "Test", "photos_count": 20}
        assert calculate_quality_score(many_photos) > calculate_quality_score(no_photos)
        
    def test_handles_none_values(self):
        record = {
            "name": "Test",
            "phone": None,
            "reviews": None,
            "rating": None
        }
        # Should not raise
        score = calculate_quality_score(record)
        assert isinstance(score, float)


# =============================================================================
# deduplicate Tests
# =============================================================================

class TestDeduplicate:
    """Test deduplication logic."""
    
    def test_dedupe_returns_tuple(self):
        result = deduplicate([])
        assert isinstance(result, tuple)
        assert len(result) == 2
        
    def test_dedupe_empty_list(self):
        unique, dupes = deduplicate([])
        assert unique == []
        assert dupes == 0
        
    def test_dedupe_single_record(self):
        records = [{"name": "Test", "phone": "555-123-4567"}]
        unique, dupes = deduplicate(records)
        assert len(unique) == 1
        assert dupes == 0
        
    def test_dedupe_by_phone(self):
        records = [
            {"name": "Company A", "phone": "555-123-4567", "place_id": "a"},
            {"name": "Company A Branch", "phone": "555-123-4567", "place_id": "b"}
        ]
        unique, dupes = deduplicate(records)
        assert len(unique) == 1
        assert dupes == 1
        
    def test_dedupe_different_phones_kept(self):
        records = [
            {"name": "Company A", "phone": "555-123-4567", "place_id": "a"},
            {"name": "Company B", "phone": "555-987-6543", "place_id": "b"}
        ]
        unique, dupes = deduplicate(records)
        assert len(unique) == 2
        assert dupes == 0
        
    def test_dedupe_by_address(self):
        records = [
            {"name": "Company A", "address": "123 Main Street, Naples FL", "place_id": "a"},
            {"name": "Company A LLC", "address": "123 Main Street, Naples FL", "place_id": "b"}
        ]
        unique, dupes = deduplicate(records)
        assert len(unique) == 1
        assert dupes == 1
        
    def test_dedupe_by_website(self):
        records = [
            {"name": "Company A", "website": "https://example.com", "place_id": "a"},
            {"name": "Company A Inc", "website": "https://www.example.com/about", "place_id": "b"}
        ]
        unique, dupes = deduplicate(records)
        assert len(unique) == 1
        assert dupes == 1
        
    def test_dedupe_ignores_social_websites(self):
        """Facebook, Yelp, Google URLs should not be used for dedup."""
        records = [
            {"name": "Company A", "website": "https://facebook.com/companya", "place_id": "a"},
            {"name": "Company B", "website": "https://facebook.com/companyb", "place_id": "b"}
        ]
        unique, dupes = deduplicate(records)
        # Should NOT dedupe based on facebook.com domain
        assert len(unique) == 2
        
    def test_dedupe_keeps_first_occurrence(self):
        records = [
            {"name": "First Company", "phone": "555-123-4567", "place_id": "first"},
            {"name": "Second Company", "phone": "555-123-4567", "place_id": "second"}
        ]
        unique, dupes = deduplicate(records)
        assert unique[0]["name"] == "First Company"
        
    def test_dedupe_short_address_not_matched(self):
        """Very short addresses shouldn't be used for matching."""
        records = [
            {"name": "A", "address": "Main St", "place_id": "a"},
            {"name": "B", "address": "Main St", "place_id": "b"}
        ]
        unique, dupes = deduplicate(records)
        # Short addresses (<=15 chars) should not trigger dedup
        assert len(unique) == 2


# =============================================================================
# Edge Cases and Integration Tests
# =============================================================================

class TestEdgeCases:
    """Test edge cases and integration scenarios."""
    
    def test_record_with_all_none_values(self):
        record = {
            "name": None,
            "phone": None,
            "address": None,
            "website": None
        }
        should_rm, reason = should_remove(record)
        assert should_rm is True
        
    def test_record_with_special_characters(self):
        record = {
            "name": "ABC & Sons Dumpster's",
            "phone": "555-123-4567",
            "address": "123 Main St #100"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is False
        
    def test_unicode_in_name(self):
        record = {
            "name": "José's Dumpster Rental",
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is False
        
    def test_very_long_name(self):
        record = {
            "name": "A" * 500,
            "phone": "555-123-4567",
            "address": "123 Main St"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is False
        
    def test_international_phone_format(self):
        phone = "+44 20 7123 4567"
        result = normalize_phone(phone)
        assert result.isdigit()


class TestIntegrationScenarios:
    """Test realistic integration scenarios."""
    
    def test_typical_dumpster_company(self):
        """A typical local dumpster company should pass all checks."""
        record = {
            "name": "Naples Dumpster Rental",
            "phone": "(239) 555-1234",
            "address": "5678 Industrial Blvd, Naples, FL 34102",
            "website": "https://naplesdumpsters.com",
            "rating": 4.5,
            "reviews": 45,
            "business_status": "OPERATIONAL"
        }
        should_rm, reason = should_remove(record)
        assert should_rm is False
        
        score = calculate_quality_score(record)
        assert score > 0.6
        
    def test_dedup_workflow(self):
        """Test a realistic deduplication workflow."""
        records = [
            # Main location
            {
                "name": "ABC Dumpster Rental",
                "phone": "239-555-1234",
                "address": "123 Main St, Naples, FL",
                "website": "https://abcdumpsters.com"
            },
            # Same company, phone duplicate
            {
                "name": "ABC Dumpster - Fort Myers",
                "phone": "(239) 555-1234",
                "address": "456 Oak Ave, Fort Myers, FL",
                "website": "https://abcdumpsters.com/ftmyers"
            },
            # Different company
            {
                "name": "XYZ Containers",
                "phone": "239-555-5678",
                "address": "789 Pine Rd, Naples, FL",
                "website": "https://xyzcontainers.com"
            }
        ]
        
        unique, dupes = deduplicate(records)
        assert len(unique) == 2  # ABC and XYZ
        assert dupes == 1  # Fort Myers duplicate removed


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
