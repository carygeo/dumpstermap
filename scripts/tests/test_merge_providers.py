#!/usr/bin/env python3
"""
Test suite for merge_providers.py - Yelp provider merging
Tests cover: convert_yelp_to_provider function
"""

import pytest
import sys
from pathlib import Path

# Add scripts directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from merge_providers import convert_yelp_to_provider


# =============================================================================
# convert_yelp_to_provider Tests
# =============================================================================

class TestConvertYelpToProvider:
    """Test Yelp provider conversion to main schema."""
    
    def test_converts_basic_fields(self):
        yelp = {
            "name": "ABC Dumpster Rental",
            "city": "Naples",
            "state": "FL"
        }
        result = convert_yelp_to_provider(yelp)
        assert result["name"] == "ABC Dumpster Rental"
        assert result["city"] == "Naples"
        assert result["state"] == "FL"
        
    def test_generates_slug(self):
        yelp = {"name": "ABC Dumpster Rental"}
        result = convert_yelp_to_provider(yelp)
        assert result["slug"] == "abc-dumpster-rental"
        
    def test_slug_removes_apostrophes(self):
        yelp = {"name": "Joe's Dumpster Service"}
        result = convert_yelp_to_provider(yelp)
        assert "'" not in result["slug"]
        assert result["slug"] == "joes-dumpster-service"
        
    def test_uses_yelp_id_for_id(self):
        yelp = {"name": "Test", "yelp_id": "abc123"}
        result = convert_yelp_to_provider(yelp)
        assert result["id"] == "abc123"
        
    def test_generates_id_from_name_if_no_yelp_id(self):
        yelp = {"name": "ABC Dumpster"}
        result = convert_yelp_to_provider(yelp)
        assert result["id"] == "abc-dumpster"
        
    def test_converts_postal_code_to_zip(self):
        yelp = {"name": "Test", "postal_code": "34102"}
        result = convert_yelp_to_provider(yelp)
        assert result["zip"] == "34102"
        
    def test_converts_coordinates(self):
        yelp = {"name": "Test", "latitude": 26.142, "longitude": -81.795}
        result = convert_yelp_to_provider(yelp)
        assert result["lat"] == 26.142
        assert result["lng"] == -81.795
        
    def test_converts_reviews_to_reviewCount(self):
        yelp = {"name": "Test", "reviews": 42}
        result = convert_yelp_to_provider(yelp)
        assert result["reviewCount"] == 42
        
    def test_handles_zero_reviews(self):
        yelp = {"name": "Test", "reviews": 0}
        result = convert_yelp_to_provider(yelp)
        assert result["reviewCount"] == 0
        
    def test_handles_missing_reviews(self):
        yelp = {"name": "Test"}
        result = convert_yelp_to_provider(yelp)
        assert result["reviewCount"] == 0
        
    def test_extracts_first_photo(self):
        yelp = {
            "name": "Test",
            "photos": [
                {"url": "https://example.com/photo1.jpg"},
                {"url": "https://example.com/photo2.jpg"}
            ]
        }
        result = convert_yelp_to_provider(yelp)
        assert result["photo"] == "https://example.com/photo1.jpg"
        
    def test_handles_empty_photos_list(self):
        yelp = {"name": "Test", "photos": []}
        result = convert_yelp_to_provider(yelp)
        assert result["photo"] is None
        
    def test_handles_missing_photos(self):
        yelp = {"name": "Test"}
        result = convert_yelp_to_provider(yelp)
        assert result["photo"] is None
        
    def test_handles_photos_as_non_list(self):
        yelp = {"name": "Test", "photos": "not a list"}
        result = convert_yelp_to_provider(yelp)
        assert result["photo"] is None
        
    def test_sets_category(self):
        yelp = {"name": "Test"}
        result = convert_yelp_to_provider(yelp)
        assert result["category"] == "Dumpster rental service"
        
    def test_sets_source(self):
        yelp = {"name": "Test"}
        result = convert_yelp_to_provider(yelp)
        assert result["source"] == "yelp_sweep"
        
    def test_preserves_yelp_url(self):
        yelp = {"name": "Test", "yelp_url": "https://yelp.com/biz/test"}
        result = convert_yelp_to_provider(yelp)
        assert result["yelp_url"] == "https://yelp.com/biz/test"
        
    def test_preserves_discovery_date(self):
        yelp = {"name": "Test", "discovery_date": "2026-03-07"}
        result = convert_yelp_to_provider(yelp)
        assert result["discovery_date"] == "2026-03-07"
        
    def test_preserves_notes(self):
        yelp = {"name": "Test", "notes": "Good reviews"}
        result = convert_yelp_to_provider(yelp)
        assert result["notes"] == "Good reviews"
        
    def test_defaults_state_to_FL(self):
        yelp = {"name": "Test"}
        result = convert_yelp_to_provider(yelp)
        assert result["state"] == "FL"
        
    def test_overrides_default_state(self):
        yelp = {"name": "Test", "state": "TX"}
        result = convert_yelp_to_provider(yelp)
        assert result["state"] == "TX"


class TestConvertYelpEdgeCases:
    """Test edge cases in Yelp conversion."""
    
    def test_complete_provider_conversion(self):
        """Test a fully populated Yelp provider."""
        yelp = {
            "yelp_id": "abc-dumpster-naples",
            "name": "ABC Dumpster Rental",
            "city": "Naples",
            "state": "FL",
            "postal_code": "34102",
            "address": "123 Main St",
            "phone": "(239) 555-1234",
            "website": "https://abcdumpsters.com",
            "latitude": 26.142,
            "longitude": -81.795,
            "rating": 4.5,
            "reviews": 87,
            "photos": [
                {"url": "https://yelp.com/photo1.jpg"},
                {"url": "https://yelp.com/photo2.jpg"}
            ],
            "yelp_url": "https://yelp.com/biz/abc-dumpster-naples",
            "discovery_date": "2026-03-01",
            "notes": "High quality provider"
        }
        
        result = convert_yelp_to_provider(yelp)
        
        assert result["id"] == "abc-dumpster-naples"
        assert result["name"] == "ABC Dumpster Rental"
        assert result["slug"] == "abc-dumpster-rental"
        assert result["city"] == "Naples"
        assert result["state"] == "FL"
        assert result["zip"] == "34102"
        assert result["address"] == "123 Main St"
        assert result["phone"] == "(239) 555-1234"
        assert result["website"] == "https://abcdumpsters.com"
        assert result["lat"] == 26.142
        assert result["lng"] == -81.795
        assert result["rating"] == 4.5
        assert result["reviewCount"] == 87
        assert result["photo"] == "https://yelp.com/photo1.jpg"
        assert result["category"] == "Dumpster rental service"
        assert result["source"] == "yelp_sweep"
        
    def test_minimal_provider(self):
        """Test with minimal required fields."""
        yelp = {"name": "Test Company"}
        result = convert_yelp_to_provider(yelp)
        
        # Should have all expected keys
        expected_keys = [
            "id", "name", "slug", "city", "state", "zip",
            "address", "phone", "website", "lat", "lng",
            "rating", "reviewCount", "photo", "category",
            "yelp_url", "source", "discovery_date", "notes"
        ]
        for key in expected_keys:
            assert key in result
            
    def test_special_characters_in_name(self):
        yelp = {"name": "ABC & Sons, Inc."}
        result = convert_yelp_to_provider(yelp)
        assert "name" in result
        assert result["name"] == "ABC & Sons, Inc."
        
    def test_unicode_in_name(self):
        yelp = {"name": "José's Dumpster Rental"}
        result = convert_yelp_to_provider(yelp)
        assert result["name"] == "José's Dumpster Rental"
        assert "'" not in result["slug"]
        
    def test_empty_string_city(self):
        yelp = {"name": "Test", "city": ""}
        result = convert_yelp_to_provider(yelp)
        assert result["city"] == ""
        
    def test_none_values_handled(self):
        yelp = {
            "name": "Test",
            "city": None,
            "phone": None,
            "website": None
        }
        result = convert_yelp_to_provider(yelp)
        # Should not raise exception
        assert result["name"] == "Test"


class TestSchemaCompliance:
    """Test that converted records match expected schema."""
    
    def test_all_fields_present(self):
        yelp = {"name": "Test"}
        result = convert_yelp_to_provider(yelp)
        
        required_fields = [
            "id", "name", "slug", "city", "state", "zip",
            "address", "phone", "website", "lat", "lng",
            "rating", "reviewCount", "photo", "category",
            "yelp_url", "source", "discovery_date", "notes"
        ]
        
        for field in required_fields:
            assert field in result, f"Missing field: {field}"
            
    def test_id_is_string(self):
        yelp = {"name": "Test Company"}
        result = convert_yelp_to_provider(yelp)
        assert isinstance(result["id"], str)
        
    def test_slug_is_lowercase_hyphenated(self):
        yelp = {"name": "ABC Dumpster Rental LLC"}
        result = convert_yelp_to_provider(yelp)
        assert result["slug"] == result["slug"].lower()
        assert " " not in result["slug"]
        
    def test_reviewCount_is_number(self):
        yelp = {"name": "Test", "reviews": 42}
        result = convert_yelp_to_provider(yelp)
        assert isinstance(result["reviewCount"], (int, float))


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
